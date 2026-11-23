#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const at = (rel: string): string => join(ROOT, rel)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (value: unknown): string => JSON.stringify(value)

setTimeout(() => {
  console.log('  [FAIL] the proof ended within its two minutes')
  process.exit(1)
}, 120_000).unref()

type Row = { type: string; mode: string; session_id: string; turn?: number }
type Queued = { value: unknown; mode?: string; priority?: string; ridesNextWords?: boolean }
type Made = { tellStandingMode: () => void; noteOperatorMode: (mode: string) => void }
type Step = { name: string; makes: readonly string[]; run: (ports: object) => unknown }
type Door = { acceptInput: (input: object) => Promise<unknown> }

const order: string[] = []
let queuedAtDoor = -1
const queue = (await import(at('src/utils/messageQueueManager.ts'))) as { getCommandQueue: () => Queued[] }
const queued = (): Queued[] => queue.getCommandQueue()
mock.module(at('src/cli/headless/inputDoor.ts'), () => ({
  acceptInput: async (input: { kind: string }) => {
    order.push(`door:${input.kind}`)
    queuedAtDoor = queued().length
    return { accepted: true }
  },
  acceptInputRow: async () => ({ accepted: true }),
}))

const { watchMode } = (await import(at('src/cli/headless/boot/watchMode.ts'))) as { watchMode: Step }
const { bindInputDoor } = (await import(at('src/cli/headless/boot/bindInputDoor.ts'))) as { bindInputDoor: Step }
const { notifyPermissionModeChanged } = (await import(at('src/utils/sessionState.ts'))) as { notifyPermissionModeChanged: (mode: string) => void }
const posture = (await import(at('src/utils/cockpit/runtimePosture.ts'))) as { markSessionNonInteractive: (mode?: string) => void; getRuntimePostureSection: () => string | null }
const { setAskChannel } = (await import(at('src/bootstrap/state.ts'))) as { setAskChannel: (channel: string) => void }

type Wait = { at: number; run: () => void; unrefs: number; live: boolean }
let clock = 0
const waits: Wait[] = []
const handles = new WeakMap<object, Wait>()
const handSetTimeout = (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]): object => {
  const wait: Wait = { at: clock + delay, run: () => callback(...args), unrefs: 0, live: true }
  waits.push(wait)
  const handle = {
    ref: () => handle,
    unref: () => {
      wait.unrefs++
      return handle
    },
    hasRef: () => wait.unrefs === 0,
    refresh: () => handle,
  }
  handles.set(handle, wait)
  return handle
}
const handClearTimeout = (handle: unknown): void => {
  const wait = typeof handle === 'object' && handle !== null ? handles.get(handle) : undefined
  if (wait) wait.live = false
}
Object.assign(globalThis, { setTimeout: handSetTimeout, clearTimeout: handClearTimeout })

const advance = (ms: number): void => {
  const end = clock + ms
  for (;;) {
    const due = waits.filter(wait => wait.live && wait.at <= end).sort((a, b) => a.at - b.at)[0]
    if (!due) break
    clock = due.at
    due.live = false
    due.run()
  }
  clock = end
}
const liveWaits = (): number => waits.filter(wait => wait.live).length

const SECOND = 1_000
const WAIT = 45 * SECOND
const LINE = 'Permission mode for this run: '

const rows: Row[] = []
let turn = 1
const ports: Record<string, unknown> = {
  enqueueRow: (row: Row) => {
    rows.push(row)
  },
  liveScope: () => ({ session_id: 'proof', turn }),
}
const madeOf = (step: unknown): Made | null => (typeof step === 'object' && step !== null && 'tellStandingMode' in step && 'noteOperatorMode' in step ? (step as Made) : null)
const reminders = (from: number): string[] => queued().slice(from).map(entry => String(entry.value))
const names = (text: string | undefined, mode: string, before: string): boolean => text !== undefined && text.includes(`${LINE}${mode} (changed by the operator from ${before}`)

setAskChannel('sdk')
posture.markSessionNonInteractive('default')
const first = madeOf(watchMode.run(ports))
const made: Made = first ?? { tellStandingMode() {}, noteOperatorMode() {} }

section('1. the step and its two doors')
check('the step is named watchMode and makes the door a prompt ends the wait through and the door an operator\'s change comes in by', watchMode.name === 'watchMode' && first !== null && watchMode.makes.includes('tellStandingMode') && watchMode.makes.includes('noteOperatorMode'), j(watchMode.makes))

section('2. before the session\'s first turn nothing is handed to the agent; the first turn states the mode that stands')
{
  const from = queued().length
  made.noteOperatorMode('implement')
  advance(WAIT)
  advance(120 * SECOND)
  check('a change of mode before any turn queues no reminder, at 45 seconds or later', reminders(from).length === 0 && liveWaits() === 0, j(reminders(from)))
  const stated = posture.getRuntimePostureSection() ?? ''
  check('the first turn\'s own posture words state the mode that stands', stated.includes(`${LINE}implement`), stated.slice(0, 200))
}

section('3. after a turn: one change, then 45 seconds of rest: one reminder, and not before')
{
  const from = queued().length
  made.noteOperatorMode('flow')
  check('the change itself queues nothing', reminders(from).length === 0)
  check('it starts one wait, and the wait does not hold the run open', liveWaits() === 1 && waits.filter(wait => wait.live).every(wait => wait.unrefs > 0), `${liveWaits()} live`)
  advance(WAIT - 1)
  check('nothing a millisecond before the 45 seconds are up', reminders(from).length === 0, j(reminders(from)))
  advance(1)
  const told = queued().slice(from)
  check('at 45 seconds one reminder names the mode that stands and the mode before', told.length === 1 && names(String(told[0]?.value), 'flow', 'implement'), j(told.map(entry => entry.value)))
  check('it is queued as the released change was: a task notification, next, riding the next words', told[0]?.mode === 'task-notification' && told[0]?.priority === 'next' && told[0]?.ridesNextWords === true, j(told[0]))
  advance(120 * SECOND)
  check('it is not said twice', reminders(from).length === 1 && liveWaits() === 0, `${reminders(from).length} · ${liveWaits()} live`)
}

section('4. three quick changes, then rest: one reminder, for the last mode')
{
  const from = queued().length
  made.noteOperatorMode('sovereign')
  const afterFirst = liveWaits()
  advance(SECOND)
  made.noteOperatorMode('default')
  const afterSecond = liveWaits()
  advance(SECOND)
  made.noteOperatorMode('implement')
  check('there is one wait at a time, never two', afterFirst === 1 && afterSecond === 1 && liveWaits() === 1, `${afterFirst}, ${afterSecond}, ${liveWaits()}`)
  advance(WAIT - 2 * SECOND)
  check('45 seconds after the FIRST change nothing is said: each change starts the 45 seconds again', reminders(from).length === 0, j(reminders(from)))
  advance(2 * SECOND - 1)
  check('nothing a millisecond before 45 seconds after the last change', reminders(from).length === 0)
  advance(1)
  check('45 seconds after the last change: one reminder, naming implement, from flow', reminders(from).length === 1 && names(reminders(from)[0], 'implement', 'flow'), j(reminders(from)))
  advance(120 * SECOND)
  check('and only that one', reminders(from).length === 1)
}

section('5. there and back inside the wait: no reminder at all')
{
  const from = queued().length
  made.noteOperatorMode('default')
  advance(5 * SECOND)
  made.noteOperatorMode('flow')
  advance(3 * SECOND)
  made.noteOperatorMode('implement')
  advance(200 * SECOND)
  check('away from the mode last told and back to it: nothing is said', reminders(from).length === 0 && liveWaits() === 0, j(reminders(from)))
}

section('6. a prompt inside the wait carries the reminder at once')
{
  const from = queued().length
  made.noteOperatorMode('sovereign')
  advance(10 * SECOND)
  made.tellStandingMode()
  check('the reminder is on the queue when the prompt\'s door returns, 10 seconds in', reminders(from).length === 1 && names(reminders(from)[0], 'sovereign', 'implement'), j(reminders(from)))
  check('the wait is over', liveWaits() === 0, `${liveWaits()} live`)
  advance(200 * SECOND)
  made.tellStandingMode()
  check('nothing more is said at 45 seconds or at the next prompt', reminders(from).length === 1)
}

section('7. a prompt with nothing to tell queues nothing')
{
  const from = queued().length
  made.tellStandingMode()
  made.noteOperatorMode('flow')
  made.noteOperatorMode('sovereign')
  made.tellStandingMode()
  advance(200 * SECOND)
  check('no change, or there and back, then a prompt: nothing', reminders(from).length === 0 && liveWaits() === 0, j(reminders(from)))
}

section('8. the mode row is a signal of its own: at once on every change, whoever made it, and it starts no wait')
{
  const from = queued().length
  const before = rows.length
  turn = 7
  notifyPermissionModeChanged('flow')
  notifyPermissionModeChanged('default')
  const written = rows.slice(before)
  check('each change of one of the five modes writes its row at once', written.length === 2 && written[0]?.type === 'mode' && written[0]?.mode === 'flow' && written[1]?.mode === 'default', j(written))
  check('the row carries the live scope read when it is written', written[0]?.session_id === 'proof' && written[0]?.turn === 7, j(written[0]))
  notifyPermissionModeChanged('apollo')
  notifyPermissionModeChanged('bubble')
  check('a mode outside the five writes no row', rows.length === before + 2, j(rows.slice(before)))
  advance(200 * SECOND)
  check('a mode that moved by another road than the operator starts no wait and is not told', liveWaits() === 0 && reminders(from).length === 0, `${liveWaits()} live · ${j(reminders(from))}`)
}

section('9. every mode the operator can set counts, the sixth too')
{
  const from = queued().length
  made.noteOperatorMode('apollo')
  advance(WAIT)
  check('a change to apollo is told when it has stood 45 seconds', reminders(from).length === 1 && names(reminders(from)[0], 'apollo', 'sovereign'), j(reminders(from)))
}

section('10. the wait belongs to one run of the step')
{
  const from = queued().length
  made.noteOperatorMode('default')
  const second = madeOf(watchMode.run(ports))
  second?.tellStandingMode()
  check('a second run ends no wait of the first', second !== null && reminders(from).length === 0 && liveWaits() === 1, `${j(reminders(from))} · ${liveWaits()} live`)
  made.tellStandingMode()
  check('the first run tells its own', reminders(from).length === 1 && names(reminders(from)[0], 'default', 'apollo'), j(reminders(from)))
}

section('11. the input door ends the wait ahead of a prompt, and only of a prompt')
{
  const bound = bindInputDoor.run({ ...ports, tellStandingMode: made.tellStandingMode })
  const door = typeof bound === 'object' && bound !== null && 'acceptInput' in bound ? (bound as Door) : null
  check('the boot step gives the input door', door !== null)
  const from = queued().length
  made.noteOperatorMode('flow')
  advance(10 * SECOND)
  order.length = 0
  await door?.acceptInput({ kind: 'shell', command: 'ls' })
  await door?.acceptInput({ kind: 'note', to: 'a seat', content: 'a note' })
  check('a shell line and a note leave the wait running and queue nothing', j(order) === j(['door:shell', 'door:note']) && liveWaits() === 1 && reminders(from).length === 0, `${j(order)} · ${liveWaits()} live`)
  order.length = 0
  queuedAtDoor = -1
  await door?.acceptInput({ kind: 'prompt', content: 'carry on' })
  check('a prompt: the reminder is on the queue before the door takes the prompt', j(order) === j(['door:prompt']) && queuedAtDoor === from + 1 && names(reminders(from)[0], 'flow', 'default'), `${j(order)} · queue at the door ${queuedAtDoor - from} · ${j(reminders(from))}`)
  await door?.acceptInput({ kind: 'prompt', content: 'again' })
  check('the next prompt has nothing to carry', reminders(from).length === 1 && liveWaits() === 0)
}

console.log('\n' + (failures === 0 ? 'MODE NOTICE WAITS GREEN' : `MODE NOTICE WAITS RED: ${failures} failed`))
process.exit(failures === 0 ? 0 : 1)
