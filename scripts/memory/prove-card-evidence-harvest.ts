#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-card-evidence-harvest.ts
//  PROOF: the trace-grounding evidence HARVEST (cf. Socratic-SWE —
//  src/memdir/evidenceHarvest.ts + the BuildCardInput.harvestedEvidence block).
//
//  Asserts:
//   1. harvestCommitEvidence resolves a REAL sha (scratch git repo) into a
//      structural summary line, and yields an honest null for a fabricated
//      sha / no sha ref (a fake ref harvests NOTHING — the anti-confabulation
//      property).
//   2. harvestTraceEvidence aggregates a JSONL fixture into ONE argless
//      structural line (counts + fails only), windows out stale records, and
//      yields null when the sidecar is absent.
//   3. the card builder renders the "Evidence (harvested)" block only when
//      lines are provided, clamps count+length, and REFUSES a secret-bearing
//      harvested line like every other disk-bound field.
//   4. the tool wiring is gated on cardTraceGroundEnabled() AND greenGate
//      (structural — one knob for the trace-grounding family).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  harvestCardEvidence,
  harvestCommitEvidence,
  harvestTraceEvidence,
} from '../../src/memdir/evidenceHarvest.ts'
import { buildExperienceCard } from '../../src/memdir/experienceCards.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' card evidence harvest — proof')
console.log('============================================================')

// Scratch git repo with one real commit.
const repo = mkdtempSync(join(tmpdir(), 'hermes-harvest-'))
execSync('git init -q && git -c user.email=p@p -c user.name=p commit -q --allow-empty -m seed', { cwd: repo })
writeFileSync(join(repo, 'alpha.ts'), 'export const a = 1\n')
writeFileSync(join(repo, 'beta.ts'), 'export const b = 2\n')
execSync('git add . && git -c user.email=p@p -c user.name=p commit -q -m "add alpha+beta"', { cwd: repo })
const sha = execSync('git rev-parse --short HEAD', { cwd: repo, encoding: 'utf8' }).trim()

section('1. commit evidence — real sha resolves, fake sha harvests nothing')
{
  const line = await harvestCommitEvidence([`${sha}`, 'src/some/file.ts'], repo)
  check('real sha → structural summary line', line !== null && line.includes(`commit ${sha}`) && /add alpha\+beta/.test(line ?? ''))
  check('summary carries files-changed stat', /2 files? changed/.test(line ?? ''), line ?? 'null')
  check('summary names touched paths', /alpha\.ts/.test(line ?? ''))
  const fake = await harvestCommitEvidence(['deadbeefcafe'], repo)
  check('fabricated sha → honest null (harvests nothing)', fake === null)
  const none = await harvestCommitEvidence(['docs/notes.md', 'not-a-sha'], repo)
  check('no sha-shaped ref → null', none === null)
}

section('2. trace evidence — argless aggregate, windowed, absent-file null')
{
  const tracePath = join(repo, 'trace.jsonl')
  const now = Date.parse('2026-07-03T12:00:00.000Z')
  const rec = (tool: string, ok: boolean, hoursAgo: number) =>
    JSON.stringify({ ts: new Date(now - hoursAgo * 3600_000).toISOString(), tool, surface: 'builtin', risk: 'low', ok })
  writeFileSync(
    tracePath,
    [rec('Bash', true, 1), rec('Bash', false, 1), rec('Edit', true, 2), rec('Read', true, 0.5), rec('Bash', true, 24)].join('\n') + '\n',
  )
  const line = await harvestTraceEvidence({ tracePath, nowMs: now })
  check('aggregate line built', line !== null && line.startsWith('trace tail (host-wide'))
  check('counts by tool with fail counts', /Bash ×2 \(1 fail\)/.test(line ?? ''), line ?? 'null')
  check('stale record (24h) windowed OUT', !/Bash ×3/.test(line ?? ''))
  check('no arg/content material in the line (argless by design)', !/alpha|beta|\.ts/.test(line ?? ''))
  const absent = await harvestTraceEvidence({ tracePath: join(repo, 'missing.jsonl'), nowMs: now })
  check('absent sidecar → honest null', absent === null)
  const combo = await harvestCardEvidence({ sourceRefs: [sha], cwd: repo, tracePath, nowMs: now })
  check('harvestCardEvidence combines both sources', combo.length === 2)
}

section('3. builder — block rendering, clamps, secret refusal')
{
  const base = {
    name: 'harvest-proof-card',
    title: 'Harvest proof',
    summary: 'harvest block render',
    problemClass: 'proof-harness',
    lesson: 'the lesson body',
    sourceRefs: [sha],
    createdAt: '2026-07-03T12:00:00.000Z',
    greenGate: true,
  }
  const withOut = buildExperienceCard(base)
  check('no harvested lines ⇒ no evidence block', withOut.ok && !withOut.markdown.includes('Evidence (harvested)'))
  const withLines = buildExperienceCard({ ...base, harvestedEvidence: ['commit abc 2 files changed', 'trace tail (host-wide, ≤6h): Bash ×2'] })
  check('harvested lines ⇒ evidence block rendered', withLines.ok && withLines.markdown.includes('**Evidence (harvested):**') && /- commit abc/.test(withLines.markdown))
  const many = buildExperienceCard({ ...base, harvestedEvidence: Array.from({ length: 12 }, (_, i) => `line ${i} ` + 'x'.repeat(400)) })
  check('clamped to ≤6 lines, ≤300 chars each', many.ok && (many.markdown.match(/^- line /gm) ?? []).length === 6 && !/x{301}/.test(many.markdown))
  const secret = buildExperienceCard({ ...base, harvestedEvidence: ['harvested from AKIAIOSFODNN7EXAMPLE credentials'] })
  check('secret-bearing harvested line ⇒ whole card refused', !secret.ok && (secret as { blocked?: string }).blocked === 'secret-bearing')
}

section('3b. dedup identity EXCLUDES the harvested block (counts differ run-to-run)')
{
  const { normalizedLesson } = await import('../../src/memdir/experienceCards.ts')
  const mk = (evidence: string[]) => {
    const r = buildExperienceCard({
      name: 'dedup-identity-card',
      title: 'Dedup identity',
      summary: 'identity check',
      problemClass: 'proof-harness',
      lesson: 'the same transferable lesson\n- with a real lesson bullet',
      sourceRefs: [],
      createdAt: '2026-07-03T12:00:00.000Z',
      harvestedEvidence: evidence,
    })
    if (!r.ok) throw new Error('build failed')
    return r.markdown
  }
  const a = normalizedLesson(mk(['trace tail (host-wide, ≤6h): Bash ×2']))
  const b = normalizedLesson(mk(['trace tail (host-wide, ≤6h): Bash ×7 (1 fail)', 'commit abc123 (2 files changed)']))
  const c = normalizedLesson(mk([]))
  check('differing harvests ⇒ SAME identity', a === b)
  check('harvested vs none ⇒ SAME identity', a === c)
  check('the real lesson bullet survives in the identity', /with a real lesson bullet/.test(a))

  // skeptic-round-2: a model that writes the evidence HEADER inside its OWN
  // free-text lesson must NOT have that content stripped (only the trailing
  // harness block strips). Two lessons differing only in such an embedded
  // lookalike must keep DISTINCT identities — else the 2nd is silently refused
  // as a duplicate (card data loss). Anchored `$` strip guarantees this.
  const mkEmbedded = (embedded: string) => {
    const r = buildExperienceCard({
      name: 'embedded-lookalike-card',
      title: 'Embedded lookalike',
      summary: 'embed check',
      problemClass: 'proof-harness',
      lesson: `distinct lesson prose\n**Evidence (harvested):**\n- ${embedded}\nand more prose after`,
      sourceRefs: [],
      createdAt: '2026-07-03T12:00:00.000Z',
      harvestedEvidence: ['trace tail (host-wide, ≤6h): Bash ×3'],
    })
    if (!r.ok) throw new Error('build failed')
    return normalizedLesson(r.markdown)
  }
  const e1 = mkEmbedded('model-written-alpha')
  const e2 = mkEmbedded('model-written-beta')
  check('lesson-embedded lookalike SURVIVES (not stripped mid-body)', /model-written-alpha/.test(e1))
  check('two lessons differing only in the embedded lookalike ⇒ DISTINCT identity (no false dup)', e1 !== e2)
  check('the trailing harness block is still stripped from the embedded case', !/bash ×3/.test(e1))
}

section('4. tool wiring (structural) — one knob, green-gate-scoped')
{
  const tool = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'RememberLessonTool', 'RememberLessonTool.ts'), 'utf-8')
  check(
    'harvest call gated on cardTraceGroundEnabled() AND greenGatePassed',
    /if \(cardTraceGroundEnabled\(\) && input\.greenGatePassed === true\) \{[\s\S]{0,220}harvestCardEvidence/.test(tool),
  )
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` RESULT: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log(' RESULT: all checks passed')
