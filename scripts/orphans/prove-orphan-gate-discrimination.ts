#!/usr/bin/env bun
// ============================================================================
//  scripts/orphans/prove-orphan-gate-discrimination.ts — the
//  orphan gate DISCRIMINATES its seeded wrong variants (a gate that cannot
//  reject a wrong baseline is a file, not evidence — the P1-6 class).
//
//  Four seeded variants run against the REAL gate binary via its --baseline
//  seam (the canonical baseline.json is never touched; scratch copies only,
//  ambient-state law):
//    §1 the REAL baseline           → GREEN (control);
//    §2 a CURED exemption seeded    → RED naming the cure (the earlier
//       gate printed a [NOTE] and stayed green — the exact defect);
//    §3 a FRESH orphan hidden       → RED naming the fresh orphan (a row
//       removed from the baseline must surface immediately);
//    §4 a MALFORMED row seeded      → RED naming the class/reason violation.
//  §5 --regen on the cured copy PRUNES the cured row and never adds.
// ============================================================================

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const ROOT = join(import.meta.dir, '..', '..')
const GATE = join(import.meta.dir, 'prove-no-orphans.ts')
const REAL = join(import.meta.dir, 'baseline.json')
const scratch = mkdtempSync(join(tmpdir(), 'cairn-orphan-disc-'))

interface GateRun {
  code: number
  out: string
}
function runGate(args: string[]): GateRun {
  try {
    const out = execFileSync('bun', [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const baseline = JSON.parse(readFileSync(REAL, 'utf8')) as {
  rows: Array<{ file: string; class: string; reason: string }>
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — control: the real typed baseline is GREEN')
{
  const r = runGate(['--baseline', REAL])
  t.check('gate exits 0 on the real baseline', r.code === 0, `exit=${r.code}`)
  t.check('gate reports GREEN', r.out.includes('NO-ORPHANS GREEN'))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — a CURED exemption reds the gate until pruned')
{
  const seeded = {
    schema: 1,
    rows: [
      ...baseline.rows,
      {
        file: 'src/main.tsx',
        class: 'superseded-unreachable',
        reason: 'SEEDED WRONG VARIANT — this file is decisively reachable from the CLI entrypoint.',
      },
    ],
  }
  const p = join(scratch, 'cured.json')
  writeFileSync(p, JSON.stringify(seeded, null, 2))
  const r = runGate(['--baseline', p])
  t.check('gate exits non-zero on a cured exemption', r.code !== 0, `exit=${r.code}`)
  t.check('the red names the CURED class', r.out.includes('CURED exemption'))
  t.check('the red names the seeded file', r.out.includes('src/main.tsx'))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — hiding a real orphan reds the gate (fresh-orphan law)')
{
  const seeded = { schema: 1, rows: baseline.rows.slice(1) }
  const p = join(scratch, 'hidden.json')
  writeFileSync(p, JSON.stringify(seeded, null, 2))
  const r = runGate(['--baseline', p])
  t.check('gate exits non-zero when a real orphan is unlisted', r.code !== 0, `exit=${r.code}`)
  t.check('the red names the NEW orphan', r.out.includes('NEW orphan'))
  t.check('the red names the hidden file', r.out.includes(baseline.rows[0]!.file))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§4 — a malformed exemption row reds the gate')
{
  const seeded = {
    schema: 1,
    rows: [
      { ...baseline.rows[0]!, class: 'grandfathered', reason: 'legacy' },
      ...baseline.rows.slice(1),
    ],
  }
  const p = join(scratch, 'malformed.json')
  writeFileSync(p, JSON.stringify(seeded, null, 2))
  const r = runGate(['--baseline', p])
  t.check('gate exits non-zero on an invalid class / thin reason', r.code !== 0, `exit=${r.code}`)
  t.check('the red names the malformed row', r.out.includes('invalid class'))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§5 — --regen prunes cured rows and never adds')
{
  const seeded = {
    schema: 1,
    rows: [
      ...baseline.rows,
      {
        file: 'src/main.tsx',
        class: 'superseded-unreachable',
        reason: 'SEEDED WRONG VARIANT — reachable; --regen must prune exactly this row.',
      },
    ],
  }
  const p = join(scratch, 'regen.json')
  writeFileSync(p, JSON.stringify(seeded, null, 2))
  const r = runGate(['--baseline', p, '--regen'])
  t.check('--regen exits 0', r.code === 0, `exit=${r.code}`)
  const after = JSON.parse(readFileSync(p, 'utf8')) as { rows: Array<{ file: string }> }
  t.check('the cured row was pruned', !after.rows.some(x => x.file === 'src/main.tsx'))
  t.check('the real exemptions survived the prune', after.rows.length === baseline.rows.length)
  const r2 = runGate(['--baseline', p])
  t.check('the pruned copy is GREEN again', r2.code === 0, `exit=${r2.code}`)
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-orphan-gate-discrimination')
