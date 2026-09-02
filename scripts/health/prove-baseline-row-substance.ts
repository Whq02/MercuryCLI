#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-baseline-row-substance.ts — the iface-baseline row
//  certifies only a baseline that describes something present (FC-157). A
//  hand-written 79-byte manifest with zero entries and a fabricated
//  sourceSha read ok in a directory with no design system, no components
//  and no baseline.
//
//  §1 the card's fixture: zero entries ⇒ never ok.
//  §2 a junk sourceSha ⇒ warn naming the unverifiable provenance.
//  §3 entries without the grids beside them ⇒ warn.
//  §4 the real repo baseline still reads ok (control).
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-baseline-row-substance.ts
// ============================================================================
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'baserow-home-')))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

const report = await import('../../src/utils/healthReport.js')
const rowAt = async (dir: string): Promise<{ status: string; evidence: string }> => {
  process.chdir(dir)
  const cert = await report.runHealthReport({ depth: 'fast' })
  const r = cert.sections.flatMap(s => s.checks).find(c => c.id === 'iface-baseline')
  return { status: String(r?.status), evidence: String(r?.evidence) }
}
const scratchWith = (manifest: unknown, withGrids: boolean): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'baserow-')))
  mkdirSync(join(dir, 'design-system', 'live'), { recursive: true })
  writeFileSync(join(dir, 'design-system', 'live', 'manifest.json'), JSON.stringify(manifest))
  if (withGrids) {
    mkdirSync(join(dir, 'design-system', 'live', 'grids'), { recursive: true })
    writeFileSync(join(dir, 'design-system', 'live', 'grids', 'x.grid.json'), '{}')
  }
  return dir
}

console.log("§1 the card's fixture — zero entries")
{
  const r = await rowAt(scratchWith({ sourceSha: '…', entries: [], generatedAt: '1999-01-01T00:00:00Z' }, false))
  check(
    'a zero-entry manifest never reads ok',
    r.status !== 'ok' && r.evidence.includes('no entries'),
    `${r.status}: ${r.evidence}`,
  )
}

console.log('\n§2 a junk sourceSha')
{
  const r = await rowAt(
    scratchWith({ sourceSha: 'fabricated', entries: [{ id: 'x' }], generatedAt: '1999-01-01T00:00:00Z' }, true),
  )
  check(
    'a non-sha provenance warns, named',
    r.status === 'warn' && r.evidence.includes('not a commit sha'),
    `${r.status}: ${r.evidence}`,
  )
}

console.log('\n§3 entries without their grids')
{
  const r = await rowAt(
    scratchWith({ sourceSha: 'a'.repeat(40), entries: [{ id: 'x' }], generatedAt: '2026-01-01T00:00:00Z' }, false),
  )
  check(
    'a manifest whose frames are absent warns',
    r.status === 'warn' && r.evidence.includes('grids is absent'),
    `${r.status}: ${r.evidence}`,
  )
}

console.log('\n§4 the real repo baseline (control)')
{
  const r = await rowAt(ROOT)
  check(
    'the Mercury repo baseline still reads ok',
    r.status === 'ok' && / entries @ [0-9a-f]{8}/.test(r.evidence),
    `${r.status}: ${r.evidence.slice(0, 100)}`,
  )
}

console.log(failures === 0 ? '\nprove-baseline-row-substance: all green' : `\nprove-baseline-row-substance: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
