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
type Made = { tellStandingMode: () => void }
type Step = { name: string; makes: readonly string[]; run: (ports: object) => unknown }
type Door = { acceptInput: (input: object) => Promise<unknown> }

const order: string[] = []
mock.module(at('src/cli/headless/inputDoor.ts'), () => ({
  acceptInput: async (input: { kind: string }) => {
    order.push(`door:${input.kind}`)
    return { accepted: true }
  },
  acceptInputRow: async () => ({ accepted: true }),
}))

const { watchMode } = (await import(at('src/cli/headless/boot/watchMode.ts'))) as { watchMode: Step }
const { bindInputDoor } = (await import(at('src/cli/headless/boot/bindInputDoor.ts'))) as { bindInputDoor: Step }
const { notifyPermissionModeChanged } = (await import(at('src/utils/sessionState.ts'))) as { notifyPermissionModeChanged: (mode: string) => void }

type Wait = { at: number; run: () => void; unrefs: number; live: boolean }
let clock = 0
let waits: Wait[] = []
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

function session(startMode: string) {
  waits = []
  const rows: Row[] = []
  let mode = startMode
  let turn = 1
  const ports: Record<string, unknown> = {
    getAppState: () => ({ toolPermissionContext: { mode } }),
    enqueueRow: (row: Row) => {
      rows.push(row)
      order.push(`row:${row.mode}`)
    },
    liveScope: () => ({ session_id: 'proof', turn }),
  }
  const made = watchMode.run(ports)
  const tell = typeof made === 'object' && made !== null && 'tellStandingMode' in made ? (made as Made).tellStandingMode : null
  return {
    rows,
    ports,
    tell: (): void => tell?.(),
    made: tell !== null,
    press: (next: string): void => {
      mode = next
      notifyPermissionModeChanged(next)
    },
    turnIs: (next: number): void => {
      turn = next
    },
    modes: (): string => rows.map(row => row.mode).join(','),
  }
}

section('1. one press, then 45 seconds of rest: one notice, and not before')
{
  const s = session('default')
  check('the step is named watchMode and makes the door a prompt ends the wait through', watchMode.name === 'watchMode' && j(watchMode.makes) === j(['tellStandingMode']) && s.made, j(watchMode.makes))
  s.press('implement')
  check('the press itself writes no notice', s.rows.length === 0, s.modes())
  check('the press starts one wait, and the wait does not hold the run open', liveWaits() === 1 && waits.every(wait => wait.unrefs > 0), `${liveWaits()} live, unrefs ${j(waits.map(wait => wait.unrefs))}`)
  advance(WAIT - 1)
  check('no notice a millisecond before the 45 seconds are up', s.rows.length === 0, s.modes())
  s.turnIs(7)
  advance(1)
  check('at 45 seconds one notice names the mode that stands', s.modes() === 'implement' && s.rows[0]?.type === 'mode', j(s.rows))
  check('the notice carries the live scope read when it is written', s.rows[0]?.session_id === 'proof' && s.rows[0]?.turn === 7, j(s.rows[0]))
  advance(120 * SECOND)
  check('the notice is not said twice', s.rows.length === 1 && liveWaits() === 0, `${s.modes()} · ${liveWaits()} live`)
}

section('2. three quick presses, then rest: one notice, for the last mode')
{
  const s = session('default')
  s.press('implement')
  const afterFirst = liveWaits()
  advance(SECOND)
  s.press('sovereign')
  const afterSecond = liveWaits()
  advance(SECOND)
  s.press('flow')
  check('there is one wait at a time, never two', afterFirst === 1 && afterSecond === 1 && liveWaits() === 1, `${afterFirst}, ${afterSecond}, ${liveWaits()}`)
  advance(WAIT - 2 * SECOND)
  check('45 seconds after the FIRST press nothing is said: each press starts the 45 seconds again', s.rows.length === 0, s.modes())
  advance(2 * SECOND - 1)
  check('nothing a millisecond before 45 seconds after the last press', s.rows.length === 0, s.modes())
  advance(1)
  check('45 seconds after the last press: one notice, naming flow', s.modes() === 'flow', s.modes())
  advance(120 * SECOND)
  check('and only that one', s.modes() === 'flow', s.modes())
}

section('3. there and back inside the wait: no notice at all')
{
  const s = session('default')
  s.press('implement')
  advance(5 * SECOND)
  s.press('default')
  advance(200 * SECOND)
  check('from the starting mode to another and back: nothing is said', s.rows.length === 0, s.modes())
  const t = session('sovereign')
  t.press('default')
  advance(3 * SECOND)
  t.press('flow')
  advance(3 * SECOND)
  t.press('sovereign')
  advance(200 * SECOND)
  check('the starting mode is the session\'s own, read when the step runs', t.rows.length === 0, t.modes())
}

section('4. a prompt inside the wait carries the notice at once')
{
  const s = session('default')
  s.press('sovereign')
  advance(10 * SECOND)
  s.tell()
  check('the notice is written at the prompt, 10 seconds in', s.modes() === 'sovereign', s.modes())
  check('the wait is over', liveWaits() === 0, `${liveWaits()} live`)
  advance(200 * SECOND)
  s.tell()
  check('nothing more is said at 45 seconds or at the next prompt', s.modes() === 'sovereign', s.modes())
}

section('5. a prompt with nothing to tell writes nothing')
{
  const s = session('default')
  s.tell()
  check('no press, a prompt: nothing', s.rows.length === 0, s.modes())
  s.press('implement')
  s.press('default')
  s.tell()
  check('there and back, then a prompt: nothing', s.rows.length === 0 && liveWaits() === 0, `${s.modes()} · ${liveWaits()} live`)
  advance(200 * SECOND)
  check('and nothing later', s.rows.length === 0, s.modes())
}

section('6. after a notice, the mode last told is that notice\'s mode')
{
  const s = session('default')
  s.press('flow')
  advance(WAIT)
  s.press('default')
  advance(SECOND)
  s.press('flow')
  advance(200 * SECOND)
  check('away from the told mode and back: no second notice', s.modes() === 'flow', s.modes())
  s.press('default')
  advance(WAIT)
  check('a mode that stands 45 seconds after that is told', s.modes() === 'flow,default', s.modes())
}

section('7. a mode outside the five is passed over')
{
  const s = session('default')
  s.press('apollo')
  check('it starts no wait', liveWaits() === 0, `${liveWaits()} live`)
  advance(200 * SECOND)
  check('and writes nothing', s.rows.length === 0, s.modes())
  s.press('implement')
  advance(10 * SECOND)
  notifyPermissionModeChanged('apollo')
  notifyPermissionModeChanged('bubble')
  advance(WAIT - 10 * SECOND - 1)
  check('inside a wait it neither ends the wait nor starts it again', s.rows.length === 0 && liveWaits() === 1, `${s.modes()} · ${liveWaits()} live`)
  advance(1)
  check('and the mode that stands is still the last of the five', s.modes() === 'implement', s.modes())
}

section('8. the wait belongs to one run of the step')
{
  const a = session('default')
  a.press('implement')
  const keptWaits = waits
  const b = session('default')
  waits = keptWaits
  b.tell()
  check('a second run ends no wait of the first', b.rows.length === 0 && a.rows.length === 0 && liveWaits() === 1, `${a.modes()} | ${b.modes()} · ${liveWaits()} live`)
  a.tell()
  check('the first run tells its own', a.modes() === 'implement' && b.rows.length === 0, `${a.modes()} | ${b.modes()}`)
}

section('9. the input door ends the wait ahead of a prompt, and only of a prompt')
{
  const s = session('default')
  const bound = bindInputDoor.run({ ...s.ports, tellStandingMode: s.tell })
  const door = typeof bound === 'object' && bound !== null && 'acceptInput' in bound ? (bound as Door) : null
  check('the boot step gives the input door', door !== null)
  s.press('sovereign')
  advance(10 * SECOND)
  order.length = 0
  await door?.acceptInput({ kind: 'shell', command: 'ls' })
  await door?.acceptInput({ kind: 'note', to: 'a seat', content: 'a note' })
  check('a shell line and a note leave the wait running', j(order) === j(['door:shell', 'door:note']) && liveWaits() === 1, `${j(order)} · ${liveWaits()} live`)
  order.length = 0
  await door?.acceptInput({ kind: 'prompt', content: 'carry on' })
  check('a prompt: the notice is written first, then the door takes the prompt', j(order) === j(['row:sovereign', 'door:prompt']), j(order))
  order.length = 0
  await door?.acceptInput({ kind: 'prompt', content: 'again' })
  check('the next prompt has nothing to carry', j(order) === j(['door:prompt']), j(order))
}

console.log('\n' + (failures === 0 ? 'MODE NOTICE WAITS GREEN' : `MODE NOTICE WAITS RED: ${failures} failed`))
process.exit(failures === 0 ? 0 : 1)
