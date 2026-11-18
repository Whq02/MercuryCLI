#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NESTED, record, type NestedRecording } from './nestedTurnScenarios.ts'

const SELF = 'scripts/core-runtime/prove-nested-turn-recording.ts'
const SCENARIO_FILE = 'scripts/core-runtime/nestedTurnScenarios.ts'
const STARTERS = ['runAgent', 'runForkedAgent', 'runCrewmateHook']

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the nested turn recording exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const args = process.argv.slice(2)
const valueOf = (flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}
const writeTo = valueOf('--write')
const against = valueOf('--against')
const only = valueOf('--only')

const textOf = (recording: NestedRecording): string => JSON.stringify(recording, null, 1) + '\n'
const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
const outcomeOf = (recording: NestedRecording): string => {
  const outcome = recording.outcome as { thrown?: unknown; returned?: { kind?: unknown } } | undefined
  if (outcome?.thrown !== undefined) return `thrown ${JSON.stringify(outcome.thrown)}`
  return typeof outcome?.returned === 'object' && outcome.returned !== null && typeof outcome.returned.kind === 'string' ? outcome.returned.kind : 'returned'
}
const laneOf = (recording: NestedRecording, lane: string): number => recording.log.filter(entry => (entry as { lane?: string }).lane === lane).length

console.log('============================================================')
console.log(' a turn started from inside a turn, recorded: what the door was asked, every row it yields, how it ends, and what the starter hands back')
console.log('============================================================')

const scenarios = only === undefined ? NESTED : NESTED.filter(scenario => scenario.name === only)
const recordings: NestedRecording[] = []
for (const scenario of scenarios) recordings.push(await record(scenario))

section(`(1) each of the ${scenarios.length} scenarios starts its turn through the door it was handed and ends the way it names`)
for (const [index, scenario] of scenarios.entries()) {
  const recording = recordings[index]!
  check(
    `${scenario.name}: ${scenario.starter} starts ${scenario.ends.length} turn through the door, it ends ${scenario.ends.join(', ')}, and the starter hands back ${scenario.outcome} (${laneOf(recording, 'door')} rows at the door, ${recording.modelCalls} model calls)`,
    recording.turns === scenario.ends.length && JSON.stringify(recording.ends) === JSON.stringify(scenario.ends) && outcomeOf(recording) === scenario.outcome,
    `it started ${recording.turns} turn(s) through the door, ending ${JSON.stringify(recording.ends)}, and handed back ${outcomeOf(recording)} — the starter does not reach the door the rig handed it, or the nested turn behaves otherwise: a fault in src/, or a scenario to correct in ${SCENARIO_FILE}`,
  )
}

if (only === undefined) {
  section('(2) what the scenarios cover')
  const unreached = STARTERS.filter(starter => !scenarios.some(scenario => scenario.starter === starter))
  check(
    `each of the three that start a turn inside a turn is recorded: ${STARTERS.length - unreached.length} of ${STARTERS.length}`,
    unreached.length === 0,
    `no scenario drives ${unreached.join(', ')}: add one to NESTED in ${SCENARIO_FILE}`,
  )

  section('(3) a scenario recorded twice gives the same recording')
  const drifted: string[] = []
  for (const [index, scenario] of scenarios.entries()) {
    const again = await record(scenario)
    if (textOf(again) !== textOf(recordings[index]!)) drifted.push(scenario.name)
  }
  check(
    `the second recording of each scenario equals the first: ${scenarios.length - drifted.length} of ${scenarios.length}`,
    drifted.length === 0,
    `${drifted.join(', ')}: something in the run is not masked (a clock, an id) or carries over between runs: mask it in ${SCENARIO_FILE}`,
  )
}

if (writeTo !== undefined) {
  mkdirSync(writeTo, { recursive: true })
  const rows: string[] = []
  for (const recording of recordings) {
    const text = textOf(recording)
    writeFileSync(join(writeTo, `${recording.name}.json`), text)
    rows.push([recording.name, recording.starter, recording.ends.join(','), outcomeOf(recording), String(recording.log.length), digestOf(text)].join('\t'))
  }
  writeFileSync(join(writeTo, 'SUMMARY.tsv'), ['scenario\tstarter\tends\toutcome\tentries\tdigest', ...rows].join('\n') + '\n')
  console.log(`\n  wrote ${recordings.length} recordings to ${writeTo}`)
}

if (against !== undefined) {
  section(`(4) the recordings equal the ones in ${against}`)
  for (const recording of recordings) {
    const path = join(against, `${recording.name}.json`)
    if (!existsSync(path)) {
      check(`${recording.name}: recorded there`, false, `${path} is missing: record that tree with bun ${SELF} --write ${against}`)
      continue
    }
    const stood = readFileSync(path, 'utf8')
    const now = textOf(recording)
    let where = ''
    if (stood !== now) {
      const before = (JSON.parse(stood) as NestedRecording).log
      const at = recording.log.findIndex((entry, index) => JSON.stringify(entry) !== JSON.stringify(before[index]))
      where =
        at >= 0
          ? `entry ${at + 1} of the log differs — there: ${JSON.stringify(before[at]).slice(0, 400)} — here: ${JSON.stringify(recording.log[at]).slice(0, 400)}`
          : `the log has ${recording.log.length} entries here and ${before.length} there, or the ends or what the starter handed back differ`
    }
    check(`${recording.name}: equal`, stood === now, where)
  }
}

console.log('')
console.log(failures === 0 ? `prove-nested-turn-recording: ALL HOLD — ${checks} checks` : `prove-nested-turn-recording: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
