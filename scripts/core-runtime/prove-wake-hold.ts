#!/usr/bin/env bun
import type { QueuedCommand } from '../../src/types/textInputTypes.ts'
import { createTurnDriver, type TurnDriverPorts } from '../../src/cli/headless/turnDriver.ts'
import { REOPEN_GRACE_MS, WALL_RECHECK_MS, wallRecheckDelayMs, type WatchWall } from '../../src/tools/MonitorTool/watchMailbox.ts'

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
  console.log('\nTIMEOUT — wake-hold prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function settleTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick()
}

const WINDOW = 1000
type Turn = { at: number; blocks: string[]; mode: string }
type Sleep = { at: number; ms: number; resolve: () => void }
type Rig = {
  queue: QueuedCommand[]
  turns: Turn[]
  now: number
  running: number
  wall: WatchWall
  wallReads: number
  sleeps: Sleep[]
  asked: number[]
  ports: TurnDriverPorts
}

function makeRig(withWall: boolean): Rig {
  const rig: Rig = { queue: [], turns: [], now: 0, running: 0, wall: { closed: false }, wallReads: 0, sleeps: [], asked: [], ports: null as never }
  rig.ports = {
    dequeue: () => rig.queue.shift(),
    dequeueCommand: command => {
      const at = rig.queue.indexOf(command)
      return at < 0 ? undefined : rig.queue.splice(at, 1)[0]
    },
    peek: () => rig.queue[0],
    notifyLifecycle: () => {},
    enqueueOutput: () => {},
    writeDirect: async () => {},
    drainSdkEvents: () => [],
    executeTurn: async command => {
      const blocks = typeof command.value === 'string' ? [command.value] : command.value.map(b => (b.type === 'text' ? b.text : '?'))
      rig.turns.push({ at: rig.now, blocks, mode: command.mode })
      await tick()
    },
    beforeCycle: async () => {},
    onTurnStart: () => {},
    onTurnSettled: () => {},
    hasWaitableBackgroundTasks: () => rig.running > 0,
    hasHoldableBackgroundAgents: () => false,
    waitableBackgroundTaskCount: () => rig.running,
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
      sleep: ms =>
        new Promise<void>(resolve => {
          rig.asked.push(ms)
          rig.sleeps.push({ at: rig.now + ms, ms, resolve })
        }),
      now: () => rig.now,
    },
    queuedMainThread: () => rig.queue,
    settleWindowMs: WINDOW,
    ...(withWall
      ? {
          wall: () => {
            rig.wallReads++
            return { ...rig.wall }
          },
        }
      : {}),
  }
  return rig
}

async function advance(rig: Rig, ms: number): Promise<void> {
  const target = rig.now + ms
  await settleTicks(4)
  for (;;) {
    let due: Sleep | undefined
    for (const s of rig.sleeps) if (s.at <= target && (due === undefined || s.at < due.at)) due = s
    if (due === undefined) break
    rig.sleeps.splice(rig.sleeps.indexOf(due), 1)
    rig.now = Math.max(rig.now, due.at)
    due.resolve()
    await settleTicks(6)
  }
  rig.now = target
  await settleTicks(4)
}

let seq = 0
const notice = (id: string): QueuedCommand => ({ value: `<task-notification><task-id>${id}</task-id><status>completed</status><summary>Background command "${id}" completed</summary></task-notification>`, mode: 'task-notification', priority: 'next', queueId: `q${++seq}` }) as QueuedCommand
const prompt = (text: string): QueuedCommand => ({ value: text, mode: 'prompt', priority: 'next', queueId: `q${++seq}` }) as QueuedCommand
const idsOf = (turn: Turn): string[] => turn.blocks.map(b => /<task-id>(.*?)<\/task-id>/.exec(b)?.[1] ?? b)
const orderOf = (rig: Rig): string => rig.turns.map(t => (t.mode === 'task-notification' ? `notice:${idsOf(t).join('+')}` : `${t.mode}:${t.blocks.join('')}`)).join(' → ')
const pendingTimers = (rig: Rig): Sleep[] => rig.sleeps.filter(s => s.ms > 100)

section('H0 — the re-check delay is the mailbox\'s own: the stated reopen plus one second, else a minute, never under a second')
{
  check('a known reopen 30 s ahead → 31 s', wallRecheckDelayMs({ closed: true, reopensAtMs: 30_000 }, 0) === 30_000 + REOPEN_GRACE_MS)
  check('no reopen known → a minute', wallRecheckDelayMs({ closed: true }, 0) === WALL_RECHECK_MS)
  check('a reopen two hours ahead → capped at a minute', wallRecheckDelayMs({ closed: true, reopensAtMs: 7_200_000 }, 0) === WALL_RECHECK_MS)
  check('a reopen already past → the one-second floor', wallRecheckDelayMs({ closed: true, reopensAtMs: 10 }, 5_000) === REOPEN_GRACE_MS)
}

section('H1 — a completion on a walled lane is held: no turn, the driver goes idle, one re-check timer at the reopen plus one second')
{
  const rig = makeRig(true)
  rig.wall = { closed: true, reopensAtMs: 30_000 }
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('a'))
  driver.kick()
  await advance(rig, WINDOW + 500)
  check('no turn ran into the wall', rig.turns.length === 0, orderOf(rig))
  check('the driver is idle, not spinning on the held completion', driver.phase() === 'idle', driver.phase())
  const timers = pendingTimers(rig)
  check('exactly one re-check timer is armed, at the reopen plus the grace', timers.length === 1 && timers[0]!.at === 30_000 + REOPEN_GRACE_MS, JSON.stringify(timers.map(t => [t.at, t.ms])))
  check('the wall was read once for the held completion', rig.wallReads === 1, String(rig.wallReads))
  await advance(rig, 25_000)
  check('nothing ran and nothing was re-read before the timer', rig.turns.length === 0 && rig.wallReads === 1, `turns=${rig.turns.length} reads=${rig.wallReads}`)
  rig.wall = { closed: false }
  await advance(rig, 10_000)
  check('at the reopen the held completion ran as one turn', rig.turns.length === 1 && idsOf(rig.turns[0]!).join(',') === 'a' && rig.turns[0]!.at >= 30_000 + REOPEN_GRACE_MS, JSON.stringify(rig.turns))
  check('the queue is empty and no timer is left armed', rig.queue.length === 0 && pendingTimers(rig).length === 0, JSON.stringify(pendingTimers(rig)))
}

section('H2 — completions that land while the wall stands fold into ONE turn at the reopen; a later arrival arms no second timer')
{
  const rig = makeRig(true)
  rig.wall = { closed: true, reopensAtMs: 20_000 }
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('b1'))
  driver.kick()
  await advance(rig, WINDOW + 500)
  rig.queue.push(notice('b2'))
  driver.kick()
  await advance(rig, 500)
  rig.queue.push(notice('b3'))
  driver.kick()
  await advance(rig, 500)
  check('three completions held, still one timer', rig.turns.length === 0 && pendingTimers(rig).length === 1, `turns=${rig.turns.length} timers=${JSON.stringify(pendingTimers(rig).map(t => t.at))}`)
  rig.wall = { closed: false }
  await advance(rig, 25_000)
  check('one turn carrying the three, in arrival order', rig.turns.length === 1 && idsOf(rig.turns[0]!).join(',') === 'b1,b2,b3', JSON.stringify(rig.turns.map(idsOf)))
}

section("H3 — the operator's own words are never held: they run at once, the completion stays held behind the wall")
{
  const rig = makeRig(true)
  rig.wall = { closed: true, reopensAtMs: 60_000 }
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('c1'), prompt('the operator speaks'))
  driver.kick()
  await advance(rig, WINDOW + 500)
  check('the words ran, the completion did not', orderOf(rig) === 'prompt:the operator speaks' && rig.queue.length === 1, orderOf(rig))
  const lone = makeRig(true)
  lone.wall = { closed: true }
  const loneDriver = createTurnDriver(lone.ports)
  lone.queue.push(prompt('words alone'))
  loneDriver.kick()
  await advance(lone, 500)
  check('words alone on a walled lane run at once (the refusal is how the session observes the wall)', orderOf(lone) === 'prompt:words alone', orderOf(lone))
}

section('H4 — nothing armed, no wake: an empty queue on a walled lane reads no wall and arms no timer')
{
  const rig = makeRig(true)
  rig.wall = { closed: true, reopensAtMs: 60_000 }
  const driver = createTurnDriver(rig.ports)
  driver.kick()
  await advance(rig, 5_000)
  check('no sleep was ever asked for and the wall was never read', rig.asked.length === 0 && rig.wallReads === 0 && driver.phase() === 'idle', `asked=${rig.asked.length} reads=${rig.wallReads}`)
}

section('H5 — while a background task keeps the drain awake, the closed wall is re-read at the re-check cadence, not on every tick')
{
  const rig = makeRig(true)
  rig.wall = { closed: true }
  rig.running = 1
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('d1'))
  driver.kick()
  await advance(rig, 3 * WALL_RECHECK_MS + 5_000)
  check('the completion stayed held through three minutes of ticks', rig.turns.length === 0 && rig.queue.length === 1, orderOf(rig))
  check('the wall was read about once a minute, never per tick', rig.wallReads >= 3 && rig.wallReads <= 5, String(rig.wallReads))
  check('the drain is still awake for the running task (the existing wait), not idle', driver.phase() === 'waiting_for_agents', driver.phase())
  rig.wall = { closed: false }
  await advance(rig, WALL_RECHECK_MS + 2_000)
  check('within a minute of the reopen the completion ran once', rig.turns.length === 1 && idsOf(rig.turns[0]!).join(',') === 'd1', JSON.stringify(rig.turns))
  rig.running = 0
  await advance(rig, 500)
}

section('H6 — a wall with no stated reopen re-checks every minute; a wall still closed at its stated reopen re-arms once and delivers at the next open read')
{
  const rig = makeRig(true)
  rig.wall = { closed: true }
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('e1'))
  driver.kick()
  await advance(rig, WINDOW + 500)
  const first = pendingTimers(rig)
  check('no reopen known → the timer is a minute out', first.length === 1 && first[0]!.ms === WALL_RECHECK_MS, JSON.stringify(first.map(t => t.ms)))
  await advance(rig, WALL_RECHECK_MS + 500)
  const second = pendingTimers(rig)
  check('still closed at the re-check → re-read once, one new timer, no turn', rig.turns.length === 0 && rig.wallReads === 2 && second.length === 1, `reads=${rig.wallReads} timers=${second.length}`)
  rig.wall = { closed: false }
  await advance(rig, WALL_RECHECK_MS + 500)
  check('open at the next read → delivered once', rig.turns.length === 1 && idsOf(rig.turns[0]!).join(',') === 'e1' && pendingTimers(rig).length === 0, JSON.stringify(rig.turns))
}

section('H7 — a driver wired without the wall port keeps the settled road: a completion runs after the settle window')
{
  const rig = makeRig(false)
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('f1'))
  driver.kick()
  await advance(rig, WINDOW + 500)
  check('no wall port, no hold', rig.turns.length === 1 && idsOf(rig.turns[0]!).join(',') === 'f1', orderOf(rig))
}

section('H8 — an open wall is read once per delivery and holds nothing')
{
  const rig = makeRig(true)
  rig.wall = { closed: false }
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('g1'))
  driver.kick()
  await advance(rig, WINDOW + 500)
  check('delivered after the settle window with one wall read', rig.turns.length === 1 && rig.wallReads === 1 && pendingTimers(rig).length === 0, `turns=${rig.turns.length} reads=${rig.wallReads}`)
}

clearTimeout(watchdog)
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'wake-hold: ALL LAWS HOLD' : `wake-hold: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
