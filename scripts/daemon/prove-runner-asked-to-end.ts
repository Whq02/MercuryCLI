#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNNER_ASK_BOUND_MS, TaskRoster, decideRunnerEnd } from '../../src/daemon/roster.ts'
import { makeTally } from './dupline-world.ts'

const ROOT = join(import.meta.dir, '..', '..')
const tally = makeTally('prove-runner-asked-to-end')
const check = tally.check
const section = tally.section
const nap = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
interface Ended {
  ms: number
  code: number | null
  signal: NodeJS.Signals | null
}
const endOf = (child: ChildProcess, began: number): Promise<Ended> => new Promise(resolve => child.once('exit', (code, signal) => resolve({ ms: Date.now() - began, code, signal })))
const lapse = (ms: number): Promise<null> => new Promise(resolve => setTimeout(() => resolve(null), ms))
const words = (ended: Ended | null): string => (ended === null ? 'it still stands' : `it ended after ${ended.ms} ms with ${ended.signal === null ? `exit code ${ended.code}` : `signal ${ended.signal}`}`)
const STANDS = `process.stdin.on('end', () => {}); process.stdin.resume(); setInterval(() => {}, 1000)`
const leaves = (ms: number): string => `process.stdin.on('end', () => setTimeout(() => process.exit(7), ${ms})); process.stdin.resume(); setInterval(() => {}, 1000)`
const child = (script: string): ChildProcess => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'ignore', 'ignore'] })
interface Seat {
  entry: { short: string; state: string; outcome?: string }
  child: ChildProcess
  done: Promise<void>
  longLived: { spec: Record<string, never>; intentionalStop: boolean; turnEdges: number; spawnGeneration: number; turnActive: boolean; waitingOnAgents: number }
}
const seatOf = (held: ChildProcess, facts: { turnActive?: boolean; waitingOnAgents?: number } = {}): Seat => ({
  entry: { short: 'held', state: 'running' },
  child: held,
  done: Promise.resolve(),
  longLived: { spec: {}, intentionalStop: false, turnEdges: 0, spawnGeneration: 1, turnActive: facts.turnActive ?? false, waitingOnAgents: facts.waitingOnAgents ?? 0 },
})
type Inside = { handles: Map<string, Seat>; classifyRow(short: string, seat: Seat['longLived'], row: Record<string, unknown>): void }
const rosterOf = (platform: NodeJS.Platform, boundMs: number, seat: Seat): TaskRoster => {
  const roster = new TaskRoster({ platform, runnerAskBoundMs: boundMs } as never)
  ;(roster as unknown as Inside).handles.set('held', seat)
  return roster
}

section('S0 the choice: which runner is asked to end and which is killed')
{
  const idle = { platform: 'win32', signal: 'SIGTERM', turnActive: false, waitingOnAgents: 0, inputOpen: true } as const
  check('on win32 a runner with no turn in flight, no crewmate waited on and its input open, struck with the default signal, is asked', decideRunnerEnd(idle) === 'ask')
  const killed: Array<[string, Parameters<typeof decideRunnerEnd>[0]]> = [
    ['on a Mac', { ...idle, platform: 'darwin' }],
    ['on Linux', { ...idle, platform: 'linux' }],
    ['with a turn in flight', { ...idle, turnActive: true }],
    ['waiting on one crewmate', { ...idle, waitingOnAgents: 1 }],
    ['struck with SIGKILL', { ...idle, signal: 'SIGKILL' }],
    ['struck with SIGINT', { ...idle, signal: 'SIGINT' }],
    ['with its input already ended', { ...idle, inputOpen: false }],
  ]
  for (const [what, facts] of killed) check(`${what} it is killed, as it was`, decideRunnerEnd(facts) === 'kill')
}

section('S1 the roster knows a runner that waits on its crewmates')
{
  const held = child(STANDS)
  const seat = seatOf(held)
  const roster = rosterOf('win32', RUNNER_ASK_BOUND_MS, seat)
  const inside = roster as unknown as Inside
  inside.classifyRow('held', seat.longLived, { type: 'turn', state: 'waiting', turn_id: 'one', agents: 2 })
  const waited = seat.longLived.waitingOnAgents
  inside.classifyRow('held', seat.longLived, { type: 'turn', state: 'waiting', turn_id: 'one', agents: 0 })
  check('it keeps the count the runner’s own row says, and none once the row says none', waited === 2 && seat.longLived.waitingOnAgents === 0, `${waited} then ${seat.longLived.waitingOnAgents}`)
  held.kill('SIGKILL')
}

section('S2 a child that does not end is killed at the bound, not before')
{
  const held = child(STANDS)
  const roster = rosterOf('win32', 800, seatOf(held))
  const began = Date.now()
  const ending = endOf(held, began)
  roster.kill('held')
  await nap(400)
  const standing = held.exitCode === null && held.signalCode === null && held.stdin?.writableEnded === true
  const ended = await Promise.race([ending, lapse(6000)])
  check('asked, it still stands halfway to the bound, and its tree is killed once the bound has passed', standing && ended !== null && ended.code !== 7 && ended.ms >= 750 && ended.ms < 4800, `standing at 400 ms: ${standing}; ${words(ended)}`)
  if (ended === null) held.kill('SIGKILL')
}

section('S3 a runner that is not to be asked is struck at once, its input left open')
{
  const struck: Array<[string, NodeJS.Platform, { turnActive?: boolean; waitingOnAgents?: number }, NodeJS.Signals]> = [
    ['with a turn in flight', 'win32', { turnActive: true }, 'SIGTERM'],
    ['waiting on two crewmates', 'win32', { waitingOnAgents: 2 }, 'SIGTERM'],
    ['idle, where a signal is the ask', 'darwin', {}, 'SIGTERM'],
    ['idle, struck with SIGKILL', 'win32', {}, 'SIGKILL'],
  ]
  for (const [what, platform, facts, signal] of struck) {
    const held = child(STANDS)
    const roster = rosterOf(platform, RUNNER_ASK_BOUND_MS, seatOf(held, facts))
    const began = Date.now()
    const ending = endOf(held, began)
    roster.kill('held', signal)
    const open = held.stdin?.writableEnded === false
    const ended = await Promise.race([ending, lapse(RUNNER_ASK_BOUND_MS - 1000)])
    check(`${what}: killed as before`, open && ended !== null && ended.code !== 7 && ended.ms < RUNNER_ASK_BOUND_MS - 1500, `input left open: ${open}; ${words(ended)}`)
    if (ended === null) held.kill('SIGKILL')
  }
}

section('S4 a second kill while a runner is ending')
{
  const held = child(leaves(600))
  const roster = rosterOf('win32', RUNNER_ASK_BOUND_MS, seatOf(held))
  const began = Date.now()
  const ending = endOf(held, began)
  roster.kill('held')
  await nap(100)
  roster.kill('held')
  const ended = await Promise.race([ending, lapse(RUNNER_ASK_BOUND_MS - 1000)])
  check('with the default signal again it leaves the runner to its own end', ended !== null && ended.code === 7 && ended.ms >= 550, words(ended))
  if (ended === null) held.kill('SIGKILL')
  const slow = child(leaves(4000))
  const second = rosterOf('win32', RUNNER_ASK_BOUND_MS, seatOf(slow))
  const start = Date.now()
  const finishing = endOf(slow, start)
  second.kill('held')
  await nap(100)
  second.kill('held', 'SIGKILL')
  const cut = await Promise.race([finishing, lapse(3500)])
  check('with SIGKILL it strikes at once', cut !== null && cut.code !== 7, words(cut))
  if (cut === null) slow.kill('SIGKILL')
}

section('S5 how long the daemon’s own stop waits for the runners it asked')
{
  const none = new TaskRoster({ platform: 'win32' } as never)
  const began = Date.now()
  await none.askedSettled()
  const idle = Date.now() - began
  check('with no runner asked it waits for nothing, as today', idle < 100, `${idle} ms`)
  const held = child(STANDS)
  const roster = rosterOf('win32', 800, seatOf(held))
  const start = Date.now()
  roster.kill('held')
  await roster.askedSettled()
  const waited = Date.now() - start
  check('with one runner that does not end it waits the bound and no longer', waited >= 750 && waited < 2300, `${waited} ms on a bound of 800 ms`)
  held.kill('SIGKILL')
  const soon = child(leaves(300))
  const third = rosterOf('win32', RUNNER_ASK_BOUND_MS, seatOf(soon))
  const at = Date.now()
  third.kill('held')
  await third.askedSettled()
  const short = Date.now() - at
  check('with one that ends itself it waits until that end', short >= 250 && short < RUNNER_ASK_BOUND_MS - 2000, `${short} ms for a child that ends 300 ms after its input`)
  check('the bound a runner is given is 5 s', RUNNER_ASK_BOUND_MS === 5000, String(RUNNER_ASK_BOUND_MS))
  const main = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
  const stop = main.slice(main.indexOf('const shutdown = (signal: string) => {'), main.indexOf('const bail = setTimeout(() => process.exit(1), 15_000)'))
  const order = ['roster.kill(j.short)', 'await roster?.askedSettled()', 'setTimeout(() => process.exit(0), 250)'].map(text => stop.indexOf(text))
  const front = readFileSync(join(ROOT, 'src', 'daemon', 'ownedDaemon.ts'), 'utf8')
  check(
    'the daemon’s shutdown waits for them after it has struck its runners and before its own exit, and the front waits for its daemon the 1.5 s it did',
    order.every(place => place !== -1) && order[0]! < order[1]! && order[1]! < order[2]! && front.includes('const DAEMON_GRACEFUL_WAIT_MS = 1_500'),
    `in shutdown: ${order.join(', ')}`,
  )
}

tally.finish()
