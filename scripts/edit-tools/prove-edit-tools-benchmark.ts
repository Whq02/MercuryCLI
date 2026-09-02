#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-edit-tools-benchmark.ts — the workbench §3 corpus is
//  mechanically sound and the committed baseline projection has not drifted
//  from what the corpus actually measures.
//
//  Gate law:
//    · every mission completes (an honest UNAVAILABLE row — e.g. cargo
//      absent — is acceptable and named, never silent);
//    · ZERO false successes;
//    · ZERO unresolved refs and ZERO duplicate evidence rows;
//    · the committed scripts/edit-tools/fixtures/baseline.json matches this run's
//      stable projection on every LAW field (counts that encode journey
//      shape), so the baseline the slices are judged against cannot rot.
//      Machine-dependent rows (m3 availability) compare only when both
//      sides ran.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runCorpus, type MissionMetrics } from './bench-edit-tools.ts'

const repoRoot = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(ok: boolean, what: string): void {
  if (ok) {
    console.log(`  ok  ${what}`)
  } else {
    failures += 1
    console.error(`  RED ${what}`)
  }
}

const { missions, intents } = await runCorpus('baseline')

const unavailable = (m: MissionMetrics) => m.notes.some(n => n.startsWith('UNAVAILABLE'))

for (const m of missions) {
  check(m.done || unavailable(m), `${m.id}: completed (or honestly unavailable)`)
  check(!m.falseSuccess, `${m.id}: zero false successes`)
  check(m.unresolvedRefs === 0, `${m.id}: zero unresolved refs`)
  check(m.duplicateEvidenceRows === 0, `${m.id}: zero duplicate evidence rows`)
}

// the drift mission must observe EXACTLY one designed refusal + one re-read
const drift = missions.find(m => m.id === 'm5-drift')
check(!!drift && drift.failedEditAttempts === 1 && drift.editFormatRereads === 1,
  'm5-drift: exactly one designed stale refusal + one recovery re-read')

// committed-baseline drift ratchet — journey-shape counts must match
const committed = JSON.parse(
  readFileSync(join(repoRoot, 'scripts', 'edit-tools', 'fixtures', 'baseline.json'), 'utf8'),
) as { missions: MissionMetrics[]; intents: typeof intents }
for (const m of missions) {
  const c = committed.missions.find(x => x.id === m.id)
  if (!c) {
    check(false, `${m.id}: present in committed baseline`)
    continue
  }
  if (unavailable(m) || (c.notes ?? []).some((n: string) => n.startsWith('UNAVAILABLE'))) {
    console.log(`  ok  ${m.id}: availability differs by machine — shape compare skipped`)
    continue
  }
  const same =
    c.totalToolCalls === m.totalToolCalls &&
    c.fallbackShellCalls === m.fallbackShellCalls &&
    c.failedEditAttempts === m.failedEditAttempts &&
    c.editFormatRereads === m.editFormatRereads &&
    c.repeatedEditBytes === m.repeatedEditBytes &&
    c.explicitTxCalls === m.explicitTxCalls &&
    c.stepsToFirstGreenCheck === m.stepsToFirstGreenCheck
  check(
    same,
    `${m.id}: committed baseline shape matches the live corpus (calls ${c.totalToolCalls}=${m.totalToolCalls} shell ${c.fallbackShellCalls}=${m.fallbackShellCalls} bytes ${c.repeatedEditBytes}=${m.repeatedEditBytes} tx ${c.explicitTxCalls}=${m.explicitTxCalls})`,
  )
}

// the committed intent corpus is fixed — queries and wanted surfaces
check(
  committed.intents.length === intents.length &&
    committed.intents.every((c: { id: string; want: string }, i: number) =>
      c.id === intents[i].id && c.want === intents[i].want),
  'intent corpus: committed ids + wanted surfaces match the live corpus',
)

if (failures > 0) {
  console.error(`\nprove-anvil-benchmark: ${failures} RED`)
  process.exit(1)
}
console.log('\nprove-anvil-benchmark: GREEN')
