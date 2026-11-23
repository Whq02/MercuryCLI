#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Recording } from './turnScenarios.ts'

const SELF = 'scripts/core-runtime/prove-turn-recording.ts'
const SCENARIO_FILE = 'scripts/core-runtime/turnScenarios.ts'

const bootstrap = await import('../../src/boot/process-state/processState.ts')
const processFacts = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).map(([name, value]) => [`the name ${name}`, String(value)])),
  'the session': String(bootstrap.getSessionId()),
  'the session project folder': String(bootstrap.getSessionProjectDir()),
  'the session kind': String(bootstrap.getSessionKind()),
  'the interactive flag': String(bootstrap.getIsInteractive()),
})
const movedSince = (before: Record<string, string>): string[] => {
  const now = processFacts()
  return [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(fact => before[fact] !== now[fact])
}
const atStart = processFacts()
const { SCENARIOS, record } = await import('./turnScenarios.ts')
const movedByTheImport = movedSince(atStart)

const TRANSITIONS = [
  'next_turn',
  'overflow_recovery',
  'cut_tool_call_recovery',
  'pause_turn_continuation',
  'reasoning_only_recovery',
  'max_output_tokens_recovery',
  'stream_fault_recovery',
  'empty_reply_retry',
  'tool_call_refusal_recovery',
  'chant_recovery',
  'announced_step_nudge',
  'stop_hook_blocking',
  'checkpoint_settle_guard',
  'queued_message',
]

const TERMINALS = [
  'completed',
  'model_error',
  'image_error',
  'prompt_too_long',
  'blocking_limit',
  'rapid_refill_breaker',
  'max_turns',
  'aborted_streaming',
  'aborted_tools',
  'stop_hook_prevented',
  'hook_stopped',
  'loop_stopped',
  'tool_calls_refused',
]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the turn recording exceeded 240s')
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

const textOf = (recording: Recording): string => JSON.stringify(recording, null, 1) + '\n'
const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
const reasonOf = (terminal: unknown): string => String((terminal as { reason?: unknown } | null)?.reason ?? JSON.stringify(terminal))
const eventsOf = (recording: Recording): Array<{ kind: string; seq: number; terminal?: unknown }> =>
  recording.log.flatMap(entry => {
    const event = (entry as { event?: { kind: string; seq: number; terminal?: unknown } }).event
    return event === undefined ? [] : [event]
  })

console.log('============================================================')
console.log(' the turn machine, recorded: every event of every scenario, in order, with what the run returned')
console.log('============================================================')

const scenarios = only === undefined ? SCENARIOS : SCENARIOS.filter(scenario => scenario.name === only)
const recordings: Recording[] = []
for (const scenario of scenarios) recordings.push(await record(scenario))

section(`(1) each of the ${scenarios.length} scenarios hands over and ends the way it names`)
for (const [index, scenario] of scenarios.entries()) {
  const recording = recordings[index]!
  const events = eventsOf(recording)
  const last = events.at(-1)
  const ordered = events.every((event, at) => event.seq === at + 1)
  const announced = last?.kind === 'run_terminal' && reasonOf(last.terminal) === reasonOf(recording.terminal)
  check(
    `${scenario.name}: ${scenario.transitions.length === 0 ? 'no handover' : scenario.transitions.join(' → ')}, then ${scenario.terminal} (${events.length} events)`,
    JSON.stringify(recording.transitions) === JSON.stringify(scenario.transitions) && reasonOf(recording.terminal) === scenario.terminal && ordered && announced,
    `it handed over ${JSON.stringify(recording.transitions)} and ended ${JSON.stringify(recording.terminal)}; events numbered in order: ${ordered}; the last event announces the terminal: ${announced} — a turn that should behave so is a fault in src/engine/loop/; a turn that should now behave otherwise is said in the scenario's row of ${SCENARIO_FILE}`,
  )
}

if (only === undefined) {
  section('(2) what the scenarios cover')
  const handed = new Set(recordings.flatMap(recording => recording.transitions))
  const ended = new Set(recordings.map(recording => reasonOf(recording.terminal)))
  const unreached = TRANSITIONS.filter(reason => !handed.has(reason))
  const unended = TERMINALS.filter(reason => !ended.has(reason))
  check(
    `every handover the machine names is reached by a scenario: ${TRANSITIONS.length - unreached.length} of ${TRANSITIONS.length}`,
    unreached.length === 0,
    `no scenario hands over with ${unreached.join(', ')}: add one to SCENARIOS in ${SCENARIO_FILE}`,
  )
  check(
    `every way a run ends is reached by a scenario: ${TERMINALS.length - unended.length} of ${TERMINALS.length}`,
    unended.length === 0,
    `no scenario ends with ${unended.join(', ')}: add one to SCENARIOS in ${SCENARIO_FILE}`,
  )
  const strangers = [...[...handed].filter(reason => !TRANSITIONS.includes(reason)), ...[...ended].filter(reason => !TERMINALS.includes(reason))]
  check(
    'no scenario reaches a handover or an end this proof does not name',
    strangers.length === 0,
    `${strangers.join(', ')}: name it in TRANSITIONS or TERMINALS of ${SELF}`,
  )

  section('(3) a scenario recorded twice gives the same recording')
  const drifted: string[] = []
  const once = scenarios.filter(scenario => scenario.oncePerProcess === true)
  for (const [index, scenario] of scenarios.entries()) {
    if (scenario.oncePerProcess === true) continue
    const again = await record(scenario)
    if (textOf(again) !== textOf(recordings[index]!)) drifted.push(scenario.name)
  }
  check(
    `the second recording of each scenario equals the first: ${scenarios.length - once.length - drifted.length} of ${scenarios.length - once.length} (${once.length} hold a receipt the process gives once and are recorded once: ${once.map(scenario => scenario.name).join(', ')})`,
    drifted.length === 0,
    `${drifted.join(', ')}: something in the run is not masked (a clock, an id) or carries over between runs: mask it in ${SCENARIO_FILE}`,
  )
}

section('(4) the harness hands the process back')
check(
  'importing the harness changes no name of the environment, nor the session, its project folder, its kind or the interactive flag',
  movedByTheImport.length === 0,
  `changed by the import: ${movedByTheImport.join(', ')} — ${SCENARIO_FILE} sets what a rig needs inside openRig and nothing at its top level`,
)
const movedByTheRigs = movedSince(atStart)
check(
  'with every rig of this run closed the process is as it began: every name, the home, the session, its kind and the interactive flag',
  movedByTheRigs.length === 0,
  `not put back: ${movedByTheRigs.join(', ')} — the close of openRig in ${SCENARIO_FILE} puts back every name the rig set, the session and its posture`,
)

if (writeTo !== undefined) {
  mkdirSync(writeTo, { recursive: true })
  const rows: string[] = []
  for (const recording of recordings) {
    const text = textOf(recording)
    writeFileSync(join(writeTo, `${recording.name}.json`), text)
    rows.push([recording.name, recording.transitions.join(',') || '-', reasonOf(recording.terminal), String(eventsOf(recording).length), digestOf(text)].join('\t'))
  }
  writeFileSync(join(writeTo, 'SUMMARY.tsv'), ['scenario\thandovers\tterminal\tevents\tdigest', ...rows].join('\n') + '\n')
  console.log(`\n  wrote ${recordings.length} recordings to ${writeTo}`)
}

if (against !== undefined) {
  section(`(5) the recordings equal the ones in ${against}`)
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
      const before = (JSON.parse(stood) as Recording).log
      const at = recording.log.findIndex((entry, index) => JSON.stringify(entry) !== JSON.stringify(before[index]))
      where =
        at >= 0
          ? `entry ${at + 1} of the log differs — there: ${JSON.stringify(before[at]).slice(0, 400)} — here: ${JSON.stringify(recording.log[at]).slice(0, 400)}`
          : `the log has ${recording.log.length} entries here and ${before.length} there, or the terminal, the tool lane or what was consumed differs`
    }
    check(`${recording.name}: equal`, stood === now, where)
  }
}

console.log('')
console.log(failures === 0 ? `prove-turn-recording: ALL HOLD — ${checks} checks` : `prove-turn-recording: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
