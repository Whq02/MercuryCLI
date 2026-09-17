#!/usr/bin/env bun
import type { QueuedCommand } from '../../src/types/textInputTypes.ts'
import * as driverModule from '../../src/cli/headless/turnDriver.ts'
import type { TurnDriverPorts } from '../../src/cli/headless/turnDriver.ts'

const { createTurnDriver } = driverModule
const foldNotificationValues = (driverModule as { foldNotificationValues?: (values: Array<string | Array<{ type: string; text?: string }>>) => Array<{ type: string; text?: string }> }).foldNotificationValues

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — notification-settle prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function settleTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick()
}

const WINDOW = 1000
type Turn = { at: number; blocks: string[]; mode: string }
type Rig = {
  queue: QueuedCommand[]
  turns: Turn[]
  now: number
  running: number
  waits: number[]
  duringTurn: (() => void) | null
  ports: TurnDriverPorts
}

function makeRig(withWindow: boolean): Rig {
  const rig: Rig = { queue: [], turns: [], now: 0, running: 0, waits: [], duringTurn: null, ports: null as never }
  rig.ports = {
    dequeue: () => rig.queue.shift(),
    peek: () => rig.queue[0],
    notifyLifecycle: () => {},
    enqueueOutput: () => {},
    writeDirect: async () => {},
    drainSdkEvents: () => [],
    executeTurn: async command => {
      const blocks = typeof command.value === 'string' ? [command.value] : command.value.map(b => (b.type === 'text' ? b.text : '?'))
      rig.turns.push({ at: rig.now, blocks, mode: command.mode })
      rig.duringTurn?.()
      rig.duringTurn = null
      await tick()
    },
    beforeCycle: async () => {},
    onTurnStart: () => {},
    onTurnSettled: () => {},
    hasWaitableBackgroundTasks: () => rig.running > 0,
    hasHoldableBackgroundAgents: () => false,
    waitableBackgroundTaskCount: () => rig.running,
    onAgentWait: count => {
      rig.waits.push(count)
    },
    takePendingSuggestion: () => null,
    settleIdle: async () => 'stay',
    closeOutput: async () => {},
    notifySessionState: () => {},
    isShuttingDown: () => false,
    idleTimerStop: () => {},
    idleTimerStart: () => {},
    onCycleError: () => ({ type: 'result' }) as never,
    shutdown: () => {},
    clock: {
      sleep: async ms => {
        rig.now += ms
        await tick()
      },
      now: () => rig.now,
    },
    ...(withWindow ? { queuedMainThread: () => rig.queue, settleWindowMs: WINDOW } : {}),
  }
  return rig
}

let seq = 0
const notice = (id: string): QueuedCommand => ({ value: `<task-notification><task-id>${id}</task-id><status>completed</status><summary>Background command "${id}" completed</summary></task-notification>`, mode: 'task-notification', priority: 'later', queueId: `q${++seq}` }) as QueuedCommand
const prompt = (text: string): QueuedCommand => ({ value: text, mode: 'prompt', priority: 'next', queueId: `q${++seq}` }) as QueuedCommand
const idsOf = (turn: Turn): string[] => turn.blocks.map(b => /<task-id>(.*?)<\/task-id>/.exec(b)?.[1] ?? b)
const untilIdle = async (driver: ReturnType<typeof createTurnDriver>, rig: Rig, budgetMs: number): Promise<void> => {
  const until = rig.now + budgetMs
  while (driver.phase() !== 'idle' && rig.now < until) await settleTicks(4)
}

section('N1 — a completion on an idle main thread waits the settle window, then runs as one turn')
{
  const rig = makeRig(true)
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('a'))
  driver.kick()
  await settleTicks(6)
  check('the notification is held, not run at once', rig.turns.length === 0 && driver.phase() === 'waiting_for_agents', `turns=${rig.turns.length} phase=${driver.phase()}`)
  await untilIdle(driver, rig, 5 * WINDOW)
  check('it runs once the window has passed, as one turn', rig.turns.length === 1 && idsOf(rig.turns[0]!).join(',') === 'a', JSON.stringify(rig.turns))
  check(`the hold lasted the window (${WINDOW} ms on the driver's own clock), no longer`, rig.turns[0]!.at >= WINDOW && rig.turns[0]!.at < WINDOW + 200, `at=${rig.turns[0]?.at}`)
  check('with nothing running, the hold announces no agent wait — never a fabricated count of one', !rig.waits.some(w => w > 0), JSON.stringify(rig.waits))
}

section('N2 — a burst inside the window folds into ONE turn carrying one block per completion')
{
  const rig = makeRig(true)
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('b1'))
  driver.kick()
  await settleTicks(6)
  const arrivals = setInterval(() => {
    if (rig.now >= 300 && rig.queue.length === 1) rig.queue.push(notice('b2'), notice('b3'))
  }, 0)
  await untilIdle(driver, rig, 5 * WINDOW)
  clearInterval(arrivals)
  check('one turn, three blocks, in arrival order', rig.turns.length === 1 && idsOf(rig.turns[0]!).join(',') === 'b1,b2,b3', JSON.stringify(rig.turns.map(idsOf)))
  check('the window is measured from the FIRST completion, not re-armed by the later ones', rig.turns[0]!.at >= WINDOW && rig.turns[0]!.at < WINDOW + 200, `at=${rig.turns[0]?.at}`)
  check('the queue is empty afterwards (every completion was taken exactly once)', rig.queue.length === 0)
}

section('N3 — completions that land DURING a live turn drain as soon as it ends, without a window, folded')
{
  const rig = makeRig(true)
  const driver = createTurnDriver(rig.ports)
  rig.duringTurn = () => {
    rig.queue.push(notice('c1'), notice('c2'))
  }
  rig.queue.push(prompt('do the thing'))
  driver.kick()
  await untilIdle(driver, rig, 5 * WINDOW)
  check('the prompt ran first, then ONE folded turn for both completions', rig.turns.length === 2 && rig.turns[0]!.mode === 'prompt' && idsOf(rig.turns[1]!).join(',') === 'c1,c2', JSON.stringify(rig.turns.map(t => [t.mode, idsOf(t), t.at])))
  check('the fold started at once — no settle window after a live turn (the existing road)', rig.turns.length === 2 && rig.turns[1]!.at - rig.turns[0]!.at < WINDOW, `gap=${(rig.turns[1]?.at ?? 0) - (rig.turns[0]?.at ?? 0)}`)
}

section('N4 — a prompt queued beside a held completion ends the hold: nothing waits behind a notification')
{
  const rig = makeRig(true)
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('d1'))
  driver.kick()
  await settleTicks(6)
  rig.queue.push(prompt('a word from the operator'))
  await untilIdle(driver, rig, 5 * WINDOW)
  check('both ran before the window would have passed', rig.turns.length === 2 && rig.turns.every(t => t.at < WINDOW), JSON.stringify(rig.turns.map(t => [t.mode, idsOf(t), t.at])))
}

section('N5 — the hold announces the running count while tasks run, and the fold is a plain block list')
{
  const rig = makeRig(true)
  rig.running = 2
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('e1'))
  driver.kick()
  await settleTicks(6)
  check('while two tasks run, the hold announces 2 (the truth), not 0 and not 1', rig.waits.length > 0 && rig.waits.at(-1) === 2, JSON.stringify(rig.waits))
  rig.running = 0
  await untilIdle(driver, rig, 5 * WINDOW)
  check('the held completion still ran once', rig.turns.length === 1 && idsOf(rig.turns[0]!).join(',') === 'e1')
  const folded = foldNotificationValues?.(['<a/>', [{ type: 'text', text: '<b/>' }], '<c/>']) ?? []
  check('foldNotificationValues keeps one text block per value, strings and block lists alike', folded.length === 3 && folded.every(b => b.type === 'text') && folded.map(b => b.text ?? '').join('') === '<a/><b/><c/>', foldNotificationValues === undefined ? 'the driver exports no fold' : JSON.stringify(folded))
}

section('N6 — a driver wired without the window ports runs a completion at once (the ports are additive)')
{
  const rig = makeRig(false)
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('f1'), notice('f2'))
  driver.kick()
  await untilIdle(driver, rig, 5 * WINDOW)
  check('no hold: the turn ran at time 0, and the two consecutive completions still folded', rig.turns.length === 1 && rig.turns[0]!.at === 0 && idsOf(rig.turns[0]!).join(',') === 'f1,f2', JSON.stringify(rig.turns.map(t => [idsOf(t), t.at])))
}

clearTimeout(watchdog)
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'notification-settle: ALL LAWS HOLD' : `notification-settle: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
