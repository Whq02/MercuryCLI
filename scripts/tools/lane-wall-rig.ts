import '../lib/hermetic.ts'
import type { QueuedCommand } from '../../src/types/textInputTypes.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

export const { createTurnDriver } = await import('../../src/cli/headless/turnDriver.ts')
type TurnDriverPorts = Parameters<typeof createTurnDriver>[0]
export const { REOPEN_GRACE_MS, WALL_RECHECK_MS } = await import('../../src/tools/MonitorTool/watchMailbox.ts')
export type WatchWall = { closed: boolean; reopensAtMs?: number }
export const wallModule = (await import('../../src/tools/MonitorTool/laneWall.ts')) as unknown as { sessionLaneWall: (nowMs?: number, reads?: unknown) => WatchWall }
export type LimitWindow = { state: 'limited'; resetsAtMs: number; observedAtMs: number } | { state: 'clear' }
export type LaneWindowLeaf = {
  isLaneWindowFamily: (family: string) => boolean
  activeLaneWindow: (family: string, reads: unknown) => LimitWindow
  laneWindowFact: (family: string, reads: unknown) => { resetsAtMs: number; observedAtMs: number } | undefined
}
export const leaf = (await import('../../src/services/providers/laneWindowFact.ts').catch(() => undefined)) as unknown as LaneWindowLeaf | undefined

let failures = 0
export function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
export function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
export function finish(): never {
  console.log('\n' + '─'.repeat(76))
  console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the lane-wall prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

export const RESET = 30_000
export const WINDOW = 1000
type Lane = { provider: string; credential: string; limit: string; usable: boolean; blockers: string[] }
export const lane = (provider: string, limit: string): Lane => ({ provider, credential: 'api-key', limit, usable: limit !== 'rejected', blockers: [] })
export type Fixture = { family: string; window: () => LimitWindow }
export const readsFor = (fixture: Fixture, route: string | null, verdict: { status: string; lapsesAtMs?: number } = { status: 'unknown' }): unknown => ({
  route: () => route,
  usability: () => ({
    anthropic: lane('anthropic', verdict.status === 'rejected' ? 'rejected' : 'unknown'),
    openai: lane('openai', 'unknown'),
    [fixture.family]: lane(fixture.family, fixture.window().state === 'limited' ? 'rejected' : 'unknown'),
    zai: lane('zai', 'rejected'),
  }),
  anthropicVerdict: () => verdict,
  openaiWindow: () => ({ state: 'clear' }),
  laneWindow: (family: string) => (family === fixture.family ? fixture.window() : { state: 'clear' }),
})

export function proveWallReads(fixture: Fixture, label: string, setWindow: (w: LimitWindow) => void): void {
  section(`§1 the wall's reads — the ${label} family's window carries its reopen time; the other reads are unchanged`)
  setWindow({ state: 'limited', resetsAtMs: RESET, observedAtMs: 0 })
  const closed = wallModule.sessionLaneWall(0, readsFor(fixture, fixture.family))
  check(`a limited ${label} window closes the wall with the reset as its reopen time`, closed.closed === true && closed.reopensAtMs === RESET, JSON.stringify(closed))
  setWindow({ state: 'clear' })
  const clear = wallModule.sessionLaneWall(0, readsFor(fixture, fixture.family))
  check(`a clear ${label} window leaves the wall open`, clear.closed === false, JSON.stringify(clear))
  setWindow({ state: 'limited', resetsAtMs: RESET, observedAtMs: 0 })
  const anthropic = wallModule.sessionLaneWall(0, readsFor(fixture, 'anthropic', { status: 'rejected', lapsesAtMs: 70_000 }))
  check("a rejected Anthropic verdict closes the wall at the verdict's lapse, as before", anthropic.closed === true && anthropic.reopensAtMs === 70_000, JSON.stringify(anthropic))
  const other = wallModule.sessionLaneWall(0, readsFor(fixture, 'zai'))
  check('a family with no window fact closes without a reopen time, as before', other.closed === true && other.reopensAtMs === undefined, JSON.stringify(other))
  const none = wallModule.sessionLaneWall(0, readsFor(fixture, null))
  check('no declared route leaves the wall open', none.closed === false, JSON.stringify(none))
}

export function proveWindowFact(family: string, label: string): void {
  section(`§1b the fact the seat publishes — the ${label} lane's wall while it stands, nothing otherwise`)
  if (leaf === undefined) {
    check(`the window-fact leaf answers for the ${label} family`, false, 'src/services/providers/laneWindowFact.ts is missing')
    return
  }
  check(`${family} is a window family`, leaf.isLaneWindowFamily(family) === true)
  const limited = { credentialed: () => true, window: () => ({ state: 'limited', resetsAtMs: RESET, observedAtMs: 5 }) }
  const stated = leaf.laneWindowFact(family, limited)
  check('a limited window on a credentialed lane is the fact, with the reset and the observation', stated !== undefined && stated.resetsAtMs === RESET && stated.observedAtMs === 5, JSON.stringify(stated))
  check('a clear window states no fact', leaf.laneWindowFact(family, { credentialed: () => true, window: () => ({ state: 'clear' }) }) === undefined)
  const asked: number[] = []
  const none = { credentialed: () => false, window: () => { asked.push(1); return { state: 'limited', resetsAtMs: RESET, observedAtMs: 5 } } }
  check('no credential states no fact and reads clear, and the latch is not read', leaf.laneWindowFact(family, none) === undefined && leaf.activeLaneWindow(family, none).state === 'clear' && asked.length === 0, `latch reads: ${asked.length}`)
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function settleTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick()
}
export type Turn = { at: number; blocks: string[]; mode: string }
type Sleep = { at: number; ms: number; resolve: () => void }
export type Rig = { queue: QueuedCommand[]; turns: Turn[]; now: number; wallReads: number; sleeps: Sleep[]; ports: TurnDriverPorts }
export function makeRig(reads: unknown): Rig {
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
export async function advance(rig: Rig, ms: number): Promise<void> {
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
export const notice = (id: string): QueuedCommand => ({ value: `<task-notification><task-id>${id}</task-id><status>completed</status><summary>Background command "${id}" completed</summary></task-notification>`, mode: 'task-notification', priority: 'next', queueId: `q${++seq}` }) as QueuedCommand
export const idsOf = (turn: Turn): string[] => turn.blocks.map(b => /<task-id>(.*?)<\/task-id>/.exec(b)?.[1] ?? b)
export const pendingTimers = (rig: Rig): Sleep[] => rig.sleeps.filter(s => s.ms > 100)

export async function proveHoldRoad(fixture: Fixture, label: string, setWindow: (w: LimitWindow) => void, noticeId: string): Promise<void> {
  section(`§2 the seat's hold road on a ${label} window: a completion waits, the re-check is armed at the window's reset, and the reopen delivers it once`)
  setWindow({ state: 'limited', resetsAtMs: RESET, observedAtMs: 0 })
  const rig = makeRig(readsFor(fixture, fixture.family))
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(notice(noticeId))
  driver.kick()
  await advance(rig, WINDOW + 500)
  check(`the completion is held: no turn ran into the closed ${label} window`, rig.turns.length === 0, JSON.stringify(rig.turns))
  check('the driver is idle on the held completion', driver.phase() === 'idle', driver.phase())
  const timers = pendingTimers(rig)
  check("one re-check timer is armed at the window's reset plus the grace, not at the minute cadence", timers.length === 1 && timers[0]!.at === RESET + REOPEN_GRACE_MS && timers[0]!.at !== WALL_RECHECK_MS, JSON.stringify(timers.map(t => [t.at, t.ms])))
  await advance(rig, 25_000)
  check('before the reset nothing ran and the wall was not re-read', rig.turns.length === 0 && rig.wallReads === 1, `turns=${rig.turns.length} reads=${rig.wallReads}`)
  setWindow({ state: 'clear' })
  await advance(rig, 10_000)
  check('at the reset the held completion ran as one turn, after the reopen', rig.turns.length === 1 && idsOf(rig.turns[0]!).join(',') === noticeId && rig.turns[0]!.at >= RESET + REOPEN_GRACE_MS, JSON.stringify(rig.turns))
  check('the queue is empty and no timer is left armed', rig.queue.length === 0 && pendingTimers(rig).length === 0, JSON.stringify(pendingTimers(rig)))
}
