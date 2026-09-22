#!/usr/bin/env bun
import '../lib/hermetic.ts'
import type { QueuedCommand } from '../../src/types/textInputTypes.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

const { createTurnDriver } = await import('../../src/cli/headless/turnDriver.ts')
type TurnDriverPorts = Parameters<typeof createTurnDriver>[0]
const { REOPEN_GRACE_MS, WALL_RECHECK_MS } = await import('../../src/tools/MonitorTool/watchMailbox.ts')
type WatchWall = { closed: boolean; reopensAtMs?: number }
const wallModule = (await import('../../src/tools/MonitorTool/laneWall.ts')) as unknown as { sessionLaneWall: (nowMs?: number, reads?: unknown) => WatchWall }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the lane-wall prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

type LimitWindow = { state: 'limited'; resetsAtMs: number; observedAtMs: number } | { state: 'clear' }
type Lane = { provider: string; credential: string; limit: string; usable: boolean; blockers: string[] }
const lane = (provider: string, limit: string): Lane => ({ provider, credential: 'oauth', limit, usable: limit !== 'rejected', blockers: [] })
const RESET = 30_000
let openaiWindow: LimitWindow = { state: 'limited', resetsAtMs: RESET, observedAtMs: 0 }
const readsFor = (route: string | null, verdict: { status: string; lapsesAtMs?: number } = { status: 'unknown' }): unknown => ({
  route: () => route,
  usability: () => ({
    anthropic: lane('anthropic', verdict.status === 'rejected' ? 'rejected' : 'unknown'),
    openai: lane('openai', openaiWindow.state === 'limited' ? 'rejected' : 'unknown'),
    gemini: lane('gemini', 'rejected'),
    zai: lane('zai', 'rejected'),
  }),
  anthropicVerdict: () => verdict,
  openaiWindow: () => openaiWindow,
})

section("§1 the wall's reads — the OpenAI family's window carries its reopen time; the Anthropic read is unchanged")
{
  const openai = wallModule.sessionLaneWall(0, readsFor('openai'))
  check('a limited OpenAI window closes the wall with the reset as its reopen time', openai.closed === true && openai.reopensAtMs === RESET, JSON.stringify(openai))
  openaiWindow = { state: 'clear' }
  const clear = wallModule.sessionLaneWall(0, readsFor('openai'))
  check('a clear OpenAI window leaves the wall open', clear.closed === false, JSON.stringify(clear))
  openaiWindow = { state: 'limited', resetsAtMs: RESET, observedAtMs: 0 }
  const anthropic = wallModule.sessionLaneWall(0, readsFor('anthropic', { status: 'rejected', lapsesAtMs: 70_000 }))
  check("a rejected Anthropic verdict closes the wall at the verdict's lapse, as before", anthropic.closed === true && anthropic.reopensAtMs === 70_000, JSON.stringify(anthropic))
  const anthropicOpen = wallModule.sessionLaneWall(0, readsFor('anthropic', { status: 'allowed' }))
  check('an open Anthropic window leaves the wall open, as before', anthropicOpen.closed === false, JSON.stringify(anthropicOpen))
  const other = wallModule.sessionLaneWall(0, readsFor('zai'))
  check('another family with no window fact closes without a reopen time, as before', other.closed === true && other.reopensAtMs === undefined, JSON.stringify(other))
  const none = wallModule.sessionLaneWall(0, readsFor(null))
  check('no declared route leaves the wall open', none.closed === false, JSON.stringify(none))
}

section("§1b the fact the seat publishes — the active source's wall while it stands, nothing otherwise")
{
  const fact = (await import('../../src/services/providers/openai/openaiWindowFact.ts')) as unknown as {
    openaiWindowFact: (reads: unknown) => { source: string; resetsAtMs: number; observedAtMs: number } | undefined
    activeOpenaiWindow: (reads: unknown) => LimitWindow
  }
  const limited = { activeSource: () => 'chatgpt-subscription', window: () => ({ state: 'limited', resetsAtMs: RESET, observedAtMs: 5 }) }
  const stated = fact.openaiWindowFact(limited)
  check("a limited window on the active source is the fact, with the source, the reset and the observation", stated !== undefined && stated.source === 'chatgpt-subscription' && stated.resetsAtMs === RESET && stated.observedAtMs === 5, JSON.stringify(stated))
  check('a clear window states no fact', fact.openaiWindowFact({ activeSource: () => 'api-key', window: () => ({ state: 'clear' }) }) === undefined)
  check('no active OpenAI account states no fact and reads clear', fact.openaiWindowFact({ activeSource: () => undefined, window: () => ({ state: 'limited', resetsAtMs: RESET, observedAtMs: 5 }) }) === undefined && fact.activeOpenaiWindow({ activeSource: () => undefined, window: () => ({ state: 'limited', resetsAtMs: RESET, observedAtMs: 5 }) }).state === 'clear')
  const asked: string[] = []
  fact.activeOpenaiWindow({ activeSource: () => 'api-key', window: (source: string) => { asked.push(source); return { state: 'clear' } } })
  check("the window read is the active source's own", asked.join(',') === 'api-key', asked.join(','))
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function settleTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick()
}
const WINDOW = 1000
type Turn = { at: number; blocks: string[]; mode: string }
type Sleep = { at: number; ms: number; resolve: () => void }
type Rig = { queue: QueuedCommand[]; turns: Turn[]; now: number; wallReads: number; sleeps: Sleep[]; ports: TurnDriverPorts }
function makeRig(reads: unknown): Rig {
  const rig: Rig = { queue: [], turns: [], now: 0, wallReads: 0, sleeps: [], ports: null as never }
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
    hasWaitableBackgroundTasks: () => false,
    hasHoldableBackgroundAgents: () => false,
    waitableBackgroundTaskCount: () => 0,
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
          rig.sleeps.push({ at: rig.now + ms, ms, resolve })
        }),
      now: () => rig.now,
    },
    queuedMainThread: () => rig.queue,
    settleWindowMs: WINDOW,
    wall: () => {
      rig.wallReads++
      return wallModule.sessionLaneWall(rig.now, reads)
    },
  } as TurnDriverPorts
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
const idsOf = (turn: Turn): string[] => turn.blocks.map(b => /<task-id>(.*?)<\/task-id>/.exec(b)?.[1] ?? b)
const pendingTimers = (rig: Rig): Sleep[] => rig.sleeps.filter(s => s.ms > 100)

section("§2 the seat's hold road on an OpenAI window: a completion waits, the re-check is armed at the window's reset, and the reopen delivers it once")
{
  openaiWindow = { state: 'limited', resetsAtMs: RESET, observedAtMs: 0 }
  const rig = makeRig(readsFor('openai'))
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice('gpt-shell'))
  driver.kick()
  await advance(rig, WINDOW + 500)
  check('the completion is held: no turn ran into the closed OpenAI window', rig.turns.length === 0, JSON.stringify(rig.turns))
  check('the driver is idle on the held completion', driver.phase() === 'idle', driver.phase())
  const timers = pendingTimers(rig)
  check("one re-check timer is armed at the window's reset plus the grace, not at the minute cadence", timers.length === 1 && timers[0]!.at === RESET + REOPEN_GRACE_MS && timers[0]!.at !== WALL_RECHECK_MS, JSON.stringify(timers.map(t => [t.at, t.ms])))
  await advance(rig, 25_000)
  check('before the reset nothing ran and the wall was not re-read', rig.turns.length === 0 && rig.wallReads === 1, `turns=${rig.turns.length} reads=${rig.wallReads}`)
  openaiWindow = { state: 'clear' }
  await advance(rig, 10_000)
  check('at the reset the held completion ran as one turn, after the reopen', rig.turns.length === 1 && idsOf(rig.turns[0]!).join(',') === 'gpt-shell' && rig.turns[0]!.at >= RESET + REOPEN_GRACE_MS, JSON.stringify(rig.turns))
  check('the queue is empty and no timer is left armed', rig.queue.length === 0 && pendingTimers(rig).length === 0, JSON.stringify(pendingTimers(rig)))
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
