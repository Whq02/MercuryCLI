#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runCorpus, type MissionMetrics } from './bench-edit-tools.ts'

const repoRoot = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(ok: boolean, what: string, hint = ''): void {
  if (ok) {
    console.log(`  ok  ${what}`)
  } else {
    failures += 1
    console.error(`  RED ${what}${hint ? ` — ${hint}` : ''}`)
  }
}

const { missions, intents } = await runCorpus('baseline')

const closedLoop = missions.find(m => m.id === 'm8-closed-loop')
check(!!closedLoop && closedLoop.done && closedLoop.explicitTxCalls === 1 && closedLoop.totalToolCalls === 4,
  'T14 the checked coding loop uses one Transaction call in four total calls',
  'mission m8ClosedLoop in scripts/edit-tools/bench-edit-tools.ts must finish with one explicit Transaction call in four tool calls; fix the tool path it exercises or the mission')

const unavailable = (m: MissionMetrics) => m.notes.some(n => n.startsWith('UNAVAILABLE'))

for (const m of missions) {
  check(m.done || unavailable(m), `${m.id}: completed (or honestly unavailable)`, `the mission did not finish; read its notes (${m.notes.join(' | ')}) and fix mission ${m.id} in scripts/edit-tools/bench-edit-tools.ts or the tool it drives`)
  check(!m.falseSuccess, `${m.id}: zero false successes`, `a tool reported success the mission's own check contradicts; see mission ${m.id} in scripts/edit-tools/bench-edit-tools.ts`)
  check(m.unresolvedRefs === 0, `${m.id}: zero unresolved refs`, `${m.unresolvedRefs} ref(s) the mission used did not resolve; see mission ${m.id} in scripts/edit-tools/bench-edit-tools.ts`)
  check(m.duplicateEvidenceRows === 0, `${m.id}: zero duplicate evidence rows`, `${m.duplicateEvidenceRows} duplicate evidence row(s); an effect was recorded twice, see mission ${m.id} in scripts/edit-tools/bench-edit-tools.ts`)
}

const drift = missions.find(m => m.id === 'm5-drift')
check(!!drift && drift.failedEditAttempts === 1 && drift.editFormatRereads === 1,
  'm5-drift: exactly one designed stale refusal + one recovery re-read',
  `got failedEditAttempts=${drift?.failedEditAttempts} editFormatRereads=${drift?.editFormatRereads}; see mission m5Drift in scripts/edit-tools/bench-edit-tools.ts`)

const committed = JSON.parse(
  readFileSync(join(repoRoot, 'scripts', 'edit-tools', 'fixtures', 'baseline.json'), 'utf8'),
) as { missions: MissionMetrics[]; intents: typeof intents }
for (const m of missions) {
  const c = committed.missions.find(x => x.id === m.id)
  if (!c) {
    check(false, `${m.id}: present in committed baseline`, 'add it by running bun run scripts/edit-tools/bench-edit-tools.ts --mode baseline --write, which rewrites scripts/edit-tools/fixtures/baseline.json')
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
    `the live count (second number) moved off scripts/edit-tools/fixtures/baseline.json; fix the regression in the tool path mission ${m.id} drives, or if the change is intended run bun run scripts/edit-tools/bench-edit-tools.ts --mode baseline --write`,
  )
}

check(
  committed.intents.length === intents.length &&
    committed.intents.every((c: { id: string; want: string }, i: number) =>
      c.id === intents[i].id && c.want === intents[i].want),
  'intent corpus: committed ids + wanted surfaces match the live corpus',
  'the intents in scripts/edit-tools/bench-edit-tools.ts differ from scripts/edit-tools/fixtures/baseline.json; if the change is intended run bun run scripts/edit-tools/bench-edit-tools.ts --mode baseline --write',
)

if (failures > 0) {
  console.error(`\nprove-anvil-benchmark: ${failures} RED`)
  process.exit(1)
}
console.log('\nprove-anvil-benchmark: GREEN')
