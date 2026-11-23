#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionLiveV1 } from '../../src/engine/connector/seatLive.ts'
import type { SessionProgressEntryV1, SessionTailV1 } from '../../src/engine/connector/seatProjections.ts'
import type { WorkRowV1 } from '../../src/engine/connector/types.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const plane = mkdtempSync(join(tmpdir(), 'connector-live-part-'))
process.env.MERCURY_DAEMON_DIR = plane

const { LivePart } = await import('../../src/engine/connector/daemon/live.ts')
const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
const { publishSessionProgress } = await import('../../src/engine/connector/seatProjections.ts')
const { getEphemeralProgressFrame, clearEphemeralProgress } = await import('../../src/screen/app-state/ephemeralProgressStore.ts')
const { workCounts } = await import('../../src/engine/connector/workCounts.ts')
const { streamIdleWarningMsOf } = await import('../../src/models/roads/streamIdleBudget.ts')

let failures = 0
const WHERE = 'the part under test is LivePart in src/engine/connector/daemon/live.ts: change its behaviour there to match the check, or update this check if the law moved'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}${WHERE}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v, (_key, value) => (value instanceof Set ? [...value] : value))

type Ticker = { ms: number; fire: () => void; cleared: boolean; unref: () => void }
const tickers: Ticker[] = []
const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now }
const g = globalThis as Record<string, unknown>
g.setInterval = (fire: () => void, ms: number): Ticker => {
  const ticker: Ticker = { ms, fire, cleared: false, unref: () => {} }
  tickers.push(ticker)
  return ticker
}
g.clearInterval = (ticker: Ticker | null | undefined): void => {
  if (ticker) ticker.cleared = true
}
let clock = 3_000_000
Date.now = () => clock

type World = {
  sessionId: string
  attached: boolean
  busy: boolean
  work: WorkRowV1[]
  factsStart: number | undefined
  idleMs: number | undefined
  model: string
  delivered: boolean
  transcript: SessionLiveV1
  toolStart: number | null
  tailHeld: boolean
  foldRuns: boolean
  completionAdvances: boolean
}
type Seen = { wakes: number; redress: number; clearTail: number[]; interrupted: number[]; undone: number; folds: unknown[]; dropFold: number; cadence: boolean[]; steps: boolean[]; probes: number; models: number; toolAsked: string[][] }

let made = 0
function part(over: Partial<World> = {}): { live: InstanceType<typeof LivePart>; world: World; seen: Seen } {
  const world: World = { sessionId: `live-part-${++made}`, attached: false, busy: false, work: [], factsStart: undefined, idleMs: undefined, model: 'the-model', delivered: false, transcript: IDLE_LIVE, toolStart: null, tailHeld: false, foldRuns: true, completionAdvances: false, ...over }
  const seen: Seen = { wakes: 0, redress: 0, clearTail: [], interrupted: [], undone: 0, folds: [], dropFold: 0, cadence: [], steps: [], probes: 0, models: 0, toolAsked: [] }
  const live = new LivePart({
    sessionId: () => world.sessionId,
    attached: () => world.attached,
    factsBusy: () => world.busy,
    work: () => world.work,
    factsTurnStartedAt: () => world.factsStart,
    streamIdleTimeoutMs: () => world.idleMs,
    model: () => {
      seen.models++
      return world.model
    },
    anySendDelivered: () => world.delivered,
    redressQueuedSends: () => void seen.redress++,
    transcriptLive: () => world.transcript,
    toolStartedAtMs: inProgress => {
      seen.toolAsked.push([...inProgress])
      return world.toolStart
    },
    tailHeld: () => world.tailHeld,
    clearTail: atMs => void seen.clearTail.push(atMs),
    tailInterrupted: atMs => void seen.interrupted.push(atMs),
    tailInterruptUndone: () => void seen.undone++,
    foldStillRuns: () => world.foldRuns,
    setLiveFold: next => void seen.folds.push(next),
    dropRunningFoldAtIdle: () => void seen.dropFold++,
    stepTurnCompletion: inFlight => {
      seen.steps.push(inFlight)
      return world.completionAdvances
    },
    syncFeedCadence: inFlight => void seen.cadence.push(inFlight),
    probeCarrier: () => void seen.probes++,
  })
  live.subscribeLive(() => void seen.wakes++)
  return { live, world, seen }
}
const says = (file: Partial<SessionTailV1> & Record<string, unknown> = {}): SessionTailV1 => ({ schema: 1, sessionId: 'live-part', atMs: clock, text: null, ...file }) as SessionTailV1
const turn = (phase: SessionLiveV1['phase'], extra: Partial<SessionLiveV1> = {}): SessionLiveV1 => ({ ...IDLE_LIVE, inFlight: true, phase, ...extra })
const shown = { title: 'the chat', projectLabel: 'proof', runner: null }

section('§1 in flight: the runner says busy, or a send was delivered; the phase is read from the tail and the record')
{
  const { live, world, seen } = part()
  check('a new part is at rest, and reads at rest without waking anyone', live.live() === IDLE_LIVE && (live.recomputeLive(), seen.wakes === 0) && live.live() === IDLE_LIVE)
  world.busy = true
  live.recomputeLive()
  check('busy facts put the turn in flight, thinking while the record shows nothing, and wake once', live.live().inFlight === true && live.live().phase === 'thinking' && seen.wakes === 1, j(live.live()))
  const held = live.live()
  live.recomputeLive()
  check('the same facts read again keep the same answer and wake no one', live.live() === held && seen.wakes === 1)
  world.busy = false
  world.delivered = true
  live.recomputeLive()
  check('a delivered send keeps the turn in flight when the facts are not busy yet', live.live().inFlight === true && live.live() === held)
  world.transcript = turn('tool', { inProgressToolUseIDs: new Set(['toolu_1', 'toolu_2']) })
  live.recomputeLive()
  check('a tool the record shows running is the phase, with its ids', live.live().phase === 'tool' && j([...live.live().inProgressToolUseIDs]) === j(['toolu_1', 'toolu_2']), j(live.live()))
  live.takeTail(says({ streamBlock: 'text', blockSinceMs: clock }))
  check('words streaming do not take the phase from a running tool', live.live().phase === 'tool')
  world.transcript = turn('thinking')
  live.recomputeLive()
  check('with no tool running, streaming words read as responding', live.live().phase === 'responding', live.live().phase)
  live.takeTail(says({ streamBlock: 'thinking', blockSinceMs: clock }))
  check('a streaming thinking block reads as thinking', live.live().phase === 'thinking')
  live.takeTail(says({ streamBlock: 'tool_use', blockSinceMs: clock }))
  check('a streaming tool call reads as responding until the record shows the tool', live.live().phase === 'responding')
  live.takeTail(says({ streamBlock: 'a kind not known' as never, blockSinceMs: clock }))
  check('a block kind the part does not know is no block', live.live().phase === 'thinking' && live.status(shown).phaseMs === null)
  world.delivered = false
  live.recomputeLive()
  check('at rest the answer lists no running tool, whatever the record still shows', live.live().inFlight === false && live.live().inProgressToolUseIDs.size === 0, j(live.live()))
}

section('§2 the words of a wait: agents the turn waits on, and a fold')
{
  const roster: WorkRowV1[] = [
    { id: 'agent-a', kind: 'agent', name: 'an errand', status: 'running', startTime: 1 },
    { id: 'agent-b', kind: 'agent', name: 'another', status: 'running', startTime: 1, pendingAsks: 1 },
    { id: 'sh-1', kind: 'shell', name: 'npm test', status: 'running', startTime: 1 },
    { id: 'agent-c', kind: 'agent', name: 'a finished one', status: 'completed', startTime: 1 },
  ] as WorkRowV1[]
  const { live, world, seen } = part({ busy: true, work: roster })
  live.takeTail(says({ stateWord: 'waiting-on-agents', waitingOnAgents: 2.9 }))
  check('a wait on agents is the phase, with the whole count and the kinds counted over the roster', live.live().phase === 'waiting' && live.live().agentsWaiting === 2 && j(live.live().waitingOn) === j(workCounts(roster)) && live.stateWord() === 'waiting-on-agents', j(live.live()))
  const wakes = seen.wakes
  live.takeTail(says({ stateWord: 'waiting-on-agents', waitingOnAgents: 2 }))
  check('the same wait read again wakes no one', seen.wakes === wakes)
  live.takeTail(says({ stateWord: 'waiting-on-agents', waitingOnAgents: 0 }))
  check('a wait that names no count waits on one', live.live().agentsWaiting === 1)
  world.transcript = turn('tool', { inProgressToolUseIDs: new Set(['toolu_1']) })
  live.recomputeLive()
  check('a tool the record shows running keeps the phase over the wait', live.live().phase === 'tool' && live.live().agentsWaiting === 0 && live.live().waitingOn === undefined, j(live.live()))
  world.transcript = turn('thinking')
  live.takeTail(says({ stateWord: 'compacting' }))
  check('a fold in progress is the phase while the fold still runs', live.live().phase === 'compacting' && live.stateWord() === 'compacting')
  world.foldRuns = false
  live.recomputeLive()
  check('a fold that has ended is not the phase, whatever the word still says', live.live().phase === 'thinking', live.live().phase)
  check('no send was dressed again while the fold ran', seen.redress === 0)
  live.takeTail(says({}))
  check('leaving the fold dresses the queued sends again, once', seen.redress === 1 && live.stateWord() === null)
  live.takeTail(says({ stateWord: 'compacting' }))
  live.takeTail(says({ stateWord: 'waiting-on-agents', waitingOnAgents: 3 }))
  check('…and so does a fold that gives way to a wait', seen.redress === 2 && live.live().phase === 'waiting' && live.live().agentsWaiting === 3)

  const rest = part()
  rest.live.takeTail(says({ stateWord: 'waiting-on-agents', waitingOnAgents: 1 }))
  check('a wait word that arrives before the facts say busy is kept', rest.live.stateWord() === 'waiting-on-agents' && rest.live.live().inFlight === false)
  rest.world.busy = true
  rest.live.recomputeLive()
  rest.world.busy = false
  rest.live.recomputeLive()
  check('the turn ending drops the word', rest.live.stateWord() === null && rest.live.live().phase === 'idle')
  rest.live.takeTail(says({ stateWord: 'compacting' }))
  check('a fold word at rest is dropped at once, and the queued sends are dressed again', rest.live.stateWord() === null && rest.seen.redress === 1)
}

section("§3 the turn's start: the runner's, else the record's, else none")
{
  const startOf = (factsStart: number | undefined, record: number | null): number | null => {
    const { live } = part({ busy: true, factsStart, transcript: turn('thinking', { turnStartedAtMs: record }) })
    live.recomputeLive()
    return live.live().turnStartedAtMs
  }
  const starts = { both: startOf(500, 300), record: startOf(undefined, 300), neither: startOf(undefined, null) }
  check("the runner's start stands before the record's, and with neither there is none", starts.both === 500 && starts.record === 300 && starts.neither === null, j(starts))
}

section('§4 the figures of the tail')
{
  const { live, world, seen } = part({ busy: true })
  live.recomputeLive()
  live.takeTail(says({ turnChars: 1200, turnThinkingChars: 200, turnThinkingBlocks: 2.7, turnOutputTokens: 80, firstByteAtMs: 5, lastEventAtMs: clock - 40 }))
  check('the tail gives the counts of the turn', live.turnChars() === 1200 && live.turnOutputTokens() === 80 && j(live.turnFacts()) === j({ replyChars: 1000, thinkingChars: 200, thinkingBlocks: 2, wireOutputTokens: 80, firstByteAtMs: 5, lastByteAtMs: clock - 40, wait: null }), j(live.turnFacts()))
  live.takeTail(says({ turnChars: 10, turnThinkingChars: -5, turnThinkingBlocks: Number.NaN, turnOutputTokens: 'many' as never, firstByteAtMs: Number.POSITIVE_INFINITY }))
  check('a figure that is not a number reads as none', j(live.turnFacts()) === j({ replyChars: 10, thinkingChars: 0, thinkingBlocks: 0, wireOutputTokens: null, firstByteAtMs: null, lastByteAtMs: null, wait: null }), j(live.turnFacts()))
  live.takeTail(says({ turnChars: 30, turnThinkingChars: 90 }))
  check('the reply never counts below zero', live.turnFacts().replyChars === 0)
  const fold = { schema: 1, trigger: 'auto', startedAtMs: clock, stages: ['summarising', 'restoring'], stage: 'summarising', fill: 0.4, summaryTokens: 10, summaryCapTokens: 100, attempt: 1 }
  live.takeTail(says({ fold: fold as never }))
  live.takeTail(says({ fold: { schema: 2 } as never }))
  live.takeTail(says({}))
  check('the fold on the tail is handed on decoded, and none or an unreadable one as none', j(seen.folds.slice(-3)) === j([fold, null, null]), j(seen.folds.slice(-3)))
  const wait = { kind: 'first-byte', cold: true, promptTokens: 1200, model: 'the-model', budgetMs: 90_000, sinceMs: clock - 1000, attempt: 1 }
  const before = seen.wakes
  live.takeTail(says({ wait: wait as never }))
  const once = seen.wakes - before
  live.takeTail(says({ wait: wait as never }))
  const again = seen.wakes - before
  live.takeTail(says({}))
  check('a wait on the request wakes the listeners when it arrives and when it leaves, not while it stands', once === 1 && again === 1 && seen.wakes - before === 2 && live.turnFacts().wait === null, j({ once, again, after: seen.wakes - before }))
  live.takeTail(says({ turnChars: 77, turnOutputTokens: 9, lastEventAtMs: clock, stateWord: 'waiting-on-agents', waitingOnAgents: 1, streamBlock: 'text', blockSinceMs: clock }))
  live.tailGone()
  check('a tail that is gone leaves no count, no word, no block and no fold', live.turnChars() === 0 && live.turnOutputTokens() === null && live.stateWord() === null && live.live().phase === 'thinking' && live.status(shown).phaseMs === null && seen.folds.at(-1) === null && j(live.turnFacts()) === j({ replyChars: 0, thinkingChars: 0, thinkingBlocks: 0, wireOutputTokens: null, firstByteAtMs: null, lastByteAtMs: null, wait: null }), j(live.turnFacts()))
  live.takeTail(says({ turnChars: 50, turnOutputTokens: 4, lastEventAtMs: clock }))
  world.busy = false
  live.recomputeLive()
  check('the turn ending empties the counts, and the last byte is said only of a turn in flight', live.turnChars() === 0 && live.turnOutputTokens() === null && live.turnFacts().lastByteAtMs === null)
}

section('§5 the interrupt: one press asks, a second asks hard, and the latch lets go when the turn does')
{
  const { live, world, seen } = part({ busy: true, transcript: turn('thinking', { turnStartedAtMs: clock - 5000 }) })
  live.recomputeLive()
  const wakes = seen.wakes
  const first = live.pressInterrupt()
  check('the first press is the soft one: it marks the press, tells the tail and wakes', first?.hard === false && j(live.pressed()) === j({ interrupting: true, hardStopping: false }) && j(seen.interrupted) === j([clock]) && seen.wakes === wakes + 1, j({ first: first?.hard, pressed: live.pressed(), told: seen.interrupted }))
  clock += 300
  const second = live.pressInterrupt()
  check('the second press is the hard one, and keeps the time of the first', second?.hard === true && j(live.pressed()) === j({ interrupting: true, hardStopping: true }) && seen.interrupted.length === 1 && seen.wakes === wakes + 2)
  check('a third press asks nothing more and wakes no one', live.pressInterrupt() === null && seen.wakes === wakes + 2)
  second!.undo()
  check('a hard press the carrier refused is taken back alone', j(live.pressed()) === j({ interrupting: true, hardStopping: false }) && seen.undone === 0 && seen.wakes === wakes + 3)
  first!.undo()
  check('a soft press the carrier refused is taken back, and the tail is told', j(live.pressed()) === j({ interrupting: false, hardStopping: false }) && seen.undone === 1 && seen.wakes === wakes + 4)

  live.pressInterrupt()
  live.pressInterrupt()
  live.recomputeLive()
  check('while the pressed turn is in flight the latch holds', j(live.pressed()) === j({ interrupting: true, hardStopping: true }))
  world.busy = false
  live.recomputeLive()
  check('the turn ending lets the latch go', j(live.pressed()) === j({ interrupting: false, hardStopping: false }))

  const later = part({ busy: true, transcript: turn('thinking', { turnStartedAtMs: clock }) })
  later.live.recomputeLive()
  later.live.pressInterrupt()
  const before = later.seen.wakes
  later.live.recomputeLive()
  check('a turn that began at or after the press lets the latch go, and that alone wakes the listeners', j(later.live.pressed()) === j({ interrupting: false, hardStopping: false }) && later.seen.wakes === before + 1, j({ pressed: later.live.pressed(), wakes: later.seen.wakes - before }))
}

section('§6 tool progress: read from the projection, each step shown once')
{
  const { live, world } = part({ busy: true, transcript: turn('tool', { inProgressToolUseIDs: new Set(['toolu_sh', 'toolu_hook']) }) })
  const publish = (atMs: number, tools: Record<string, SessionProgressEntryV1>): void => publishSessionProgress({ schema: 1, sessionId: world.sessionId, atMs, tools }, plane)
  const data = (id: string): unknown => getEphemeralProgressFrame(id)?.data
  live.recomputeLive()
  live.readProgress()
  check('with no projection nothing is shown', getEphemeralProgressFrame('toolu_sh') === undefined)
  publish(10, {
    toolu_sh: { toolUseID: 'inner_sh', dataType: 'bash_progress', seq: 1, latestLine: 'one line', elapsedTimeSeconds: 2, totalLines: 1, budgetMs: 60_000 },
    toolu_ps: { toolUseID: 'inner_ps', dataType: 'powershell_progress', seq: 1, latestLine: 'a line', totalBytes: 12 },
    toolu_hook: { toolUseID: 'inner_hook', dataType: 'hook_progress', seq: 1, latestLine: 'checking', elapsedTimeSeconds: 3, budgetMs: 20_000 },
    toolu_eval: { toolUseID: 'inner_eval', dataType: 'eval_progress', seq: 1, latestLine: 'test ok', elapsedTimeSeconds: 12, budgetMs: 180_000 },
    toolu_mcp: { toolUseID: 'inner_mcp', dataType: 'mcp_progress', seq: 1, latestLine: 'half way', mcpProgress: 5, mcpTotal: 10 },
  })
  live.readProgress()
  const frame = getEphemeralProgressFrame('toolu_sh')
  check('a shell step is shown under the tool it belongs to', frame?.type === 'progress' && frame.toolUseID === 'inner_sh' && frame.parentToolUseID === 'toolu_sh' && j(frame.data) === j({ type: 'bash_progress', output: 'one line', fullOutput: 'one line', elapsedTimeSeconds: 2, totalLines: 1 }), j(frame))
  check('a PowerShell step carries its bytes', j(data('toolu_ps')) === j({ type: 'powershell_progress', output: 'a line', fullOutput: 'a line', elapsedTimeSeconds: 0, totalLines: 0, totalBytes: 12 }), j(data('toolu_ps')))
  check('a hook step carries its line, its age and its limit in seconds', j(data('toolu_hook')) === j({ type: 'hook_progress', event: 'tool.before', name: '', state: 'waiting', count: 1, line: 'checking', elapsedS: 3, timeoutS: 20 }), j(data('toolu_hook')))
  check('a cell step is a running tick with its age, its budget and its last line', j(data('toolu_eval')) === j({ type: 'eval_progress', kind: 'running', elapsedSeconds: 12, budgetMs: 180_000, tail: 'test ok' }), j(data('toolu_eval')))
  check('a server step carries its progress, its total and its words', j(data('toolu_mcp')) === j({ type: 'mcp_progress', status: 'progress', serverName: '', toolName: '', progress: 5, total: 10, progressMessage: 'half way' }), j(data('toolu_mcp')))
  live.readProgress()
  check('the same projection read again shows nothing new', getEphemeralProgressFrame('toolu_sh') === frame)
  publish(20, {
    toolu_sh: { toolUseID: 'inner_sh', dataType: 'bash_progress', seq: 1, latestLine: 'one line', elapsedTimeSeconds: 2, totalLines: 1, budgetMs: 60_000 },
    toolu_hook: { toolUseID: 'inner_hook', dataType: 'hook_progress', seq: 2, latestLine: 'still checking', elapsedTimeSeconds: 4, budgetMs: 20_000 },
  })
  live.readProgress()
  check('a later projection shows the step that moved and leaves the one that did not', getEphemeralProgressFrame('toolu_sh') === frame && (data('toolu_hook') as { line?: string }).line === 'still checking')
  clock = 5020
  world.toolStart = 1000
  const tool = live.status(shown)
  check('the budget of a running tool is the largest among those running, and its age counts on from the projection', tool.toolBudgetMs === 60_000 && tool.phaseMs === 9000, j({ toolBudgetMs: tool.toolBudgetMs, phaseMs: tool.phaseMs }))
  world.transcript = turn('tool', { inProgressToolUseIDs: new Set(['toolu_none']) })
  live.recomputeLive()
  const other = live.status(shown)
  check('a tool with no budget on the projection has none, and its age is read from the record', other.toolBudgetMs === null && other.phaseMs === 4020, j({ toolBudgetMs: other.toolBudgetMs, phaseMs: other.phaseMs }))
  publish(30, {})
  live.readProgress()
  check('a projection with no tool clears what was shown', getEphemeralProgressFrame('toolu_sh') === undefined && getEphemeralProgressFrame('toolu_hook') === undefined)
  publish(40, { toolu_sh: { toolUseID: 'inner_sh', dataType: 'bash_progress', seq: 1, budgetMs: 60_000 } })
  live.readProgress()
  world.transcript = turn('tool', { inProgressToolUseIDs: new Set(['toolu_sh']) })
  live.recomputeLive()
  const shownAgain = getEphemeralProgressFrame('toolu_sh') !== undefined && live.status(shown).toolBudgetMs === 60_000
  world.busy = false
  live.recomputeLive()
  world.busy = true
  live.recomputeLive()
  check('the turn ending clears the steps shown and the budgets kept', shownAgain && getEphemeralProgressFrame('toolu_sh') === undefined && live.status(shown).toolBudgetMs === null)
  live.readProgress()
  const unread = getEphemeralProgressFrame('toolu_sh') === undefined
  live.detached()
  live.readProgress()
  check('the window leaving forgets how far it had read, so the next window reads the projection again', unread && getEphemeralProgressFrame('toolu_sh') !== undefined)
  live.detached()
  check('…and clears what it had shown', getEphemeralProgressFrame('toolu_sh') === undefined)
  clearEphemeralProgress()
  clock = 3_000_000
}

section('§7 the status row: how long quiet, how long in this phase, and stuck only past the warning point')
{
  const WATCHDOG = 900_000
  const { live, world, seen } = part({ idleMs: WATCHDOG })
  const rest = live.status({ ...shown, isolation: 'worktree' as never, branchLabel: 'a-branch' })
  check('at rest the row says who it is and nothing of a turn', j(rest) === j({ title: 'the chat', projectLabel: 'proof', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: WATCHDOG, phaseMs: null, toolBudgetMs: null, stuck: false, isolation: 'worktree', branchLabel: 'a-branch', runner: null }), j(rest))
  check('a seat with no isolation and no branch says neither', !('isolation' in live.status(shown)) && !('branchLabel' in live.status(shown)))
  world.busy = true
  world.transcript = turn('thinking', { turnStartedAtMs: clock - 60_000 })
  live.recomputeLive()
  const unstamped = live.status(shown)
  check('a turn with no stamp from the seat has no quiet time, and its phase is as old as the turn', unstamped.quietMs === null && unstamped.phaseMs === 60_000 && unstamped.stuck === false, j(unstamped))
  live.takeTail(says({ lastEventAtMs: clock - 5000, streamBlock: 'text', blockSinceMs: clock - 2000 }))
  const stamped = live.status(shown)
  check("the quiet time is counted from the seat's stamp, the phase from where the block began", stamped.quietMs === 5000 && stamped.phaseMs === 2000, j(stamped))
  const warnAt = streamIdleWarningMsOf(WATCHDOG)
  live.takeTail(says({ lastEventAtMs: clock - (warnAt - 1), streamBlock: 'text', blockSinceMs: clock }))
  const justBefore = live.status(shown).stuck
  clock += 1
  check("stuck is said at the watchdog's warning point and not a millisecond before", justBefore === false && live.status(shown).stuck === true && live.status(shown).quietMs === warnAt, j({ justBefore, warnAt, now: live.status(shown) }))
  live.pressInterrupt()
  check('a turn being interrupted is not said to be stuck', live.status(shown).stuck === false && live.status(shown).interrupting === true)
  world.busy = false
  live.recomputeLive()
  world.busy = true
  world.transcript = turn('tool', { inProgressToolUseIDs: new Set(['toolu_1']) })
  world.toolStart = clock - 7000
  live.recomputeLive()
  live.takeTail(says({ lastEventAtMs: clock - warnAt - 1000 }))
  const tool = live.status(shown)
  check('a running tool is never said to be stuck, and its age is read from the record by its ids', tool.stuck === false && tool.quietMs === warnAt + 1000 && tool.phaseMs === 7000 && j(seen.toolAsked.at(-1)) === j(['toolu_1']), j({ tool, asked: seen.toolAsked.at(-1) }))
  world.idleMs = undefined
  world.transcript = turn('thinking')
  live.recomputeLive()
  check('with no watchdog there is no warning point and nothing is stuck', live.status(shown).watchdogMs === null && live.status(shown).stuck === false)

  const waiting = part({ busy: true, idleMs: 30_000 })
  waiting.live.recomputeLive()
  waiting.live.takeTail(says({ wait: { kind: 'first-byte', cold: true, promptTokens: 1200, model: 'the-model', budgetMs: 90_000, sinceMs: clock - 4000, attempt: 1 } as never }))
  const outstanding = waiting.live.status(shown)
  const models = waiting.seen.models
  waiting.live.status(shown)
  check("while the first byte is outstanding the watchdog is the wait's budget, and a hosted lane counts no age of its own", outstanding.watchdogMs === 90_000 && outstanding.wait?.kind === 'first-byte' && !('waitAgeMs' in outstanding), j(outstanding))
  check('whether the lane is self-hosted is asked once for a wait', models === 1 && waiting.seen.models === 1, `${models} · ${waiting.seen.models}`)
  waiting.live.takeTail(says({ wait: { kind: 'first-byte', cold: true, promptTokens: 1200, model: 'the-model', budgetMs: 90_000, sinceMs: clock - 4000, attempt: 1, promise: true } as never }))
  check('a wait that carries a promise counts its own age', waiting.live.status(shown).waitAgeMs === 4000 && waiting.seen.models === 1, j(waiting.live.status(shown)))
  waiting.live.takeTail(says({}))
  check('with the first byte in, the watchdog is the stream budget again', waiting.live.status(shown).watchdogMs === 30_000 && waiting.live.status(shown).wait === null)
  waiting.live.takeTail(says({ wait: { kind: 'first-byte', cold: true, promptTokens: 1200, model: 'the-model', budgetMs: 90_000, sinceMs: clock, attempt: 1 } as never }))
  waiting.world.busy = false
  waiting.live.recomputeLive()
  check('at rest the row speaks of no wait, whatever the tail still holds', waiting.live.status(shown).wait === null && waiting.live.status(shown).watchdogMs === 30_000)
}

section('§8 the liveness ticker: only in flight, only while a window is attached')
{
  tickers.length = 0
  const { live, world, seen } = part({ busy: true })
  live.recomputeLive()
  const detached = tickers.length
  world.busy = false
  world.attached = true
  live.recomputeLive()
  const atRest = tickers.length
  world.busy = true
  live.recomputeLive()
  live.recomputeLive()
  check('no ticker runs for a turn with no window, nor for a window at rest; one runs for a turn in a window', detached === 0 && atRest === 0 && tickers.length === 1 && tickers[0]!.ms === 1000 && tickers[0]!.cleared === false, j({ detached, atRest, armed: tickers.length }))
  const wakes = seen.wakes
  tickers[0]!.fire()
  tickers[0]!.fire()
  check('each tick wakes the listeners and asks after the carrier', seen.wakes === wakes + 2 && seen.probes === 2, j({ wakes: seen.wakes - wakes, probes: seen.probes }))
  world.busy = false
  live.recomputeLive()
  check('the turn ending stops the ticker', tickers[0]!.cleared === true)
  world.busy = true
  live.recomputeLive()
  check('the next turn starts a new one', tickers.length === 2 && tickers[1]!.cleared === false)
  live.syncLivenessTicker(false)
  check('the window leaving stops it', tickers[1]!.cleared === true)
  live.syncLivenessTicker(false)
  check('stopping a ticker that is not running does nothing', tickers.length === 2)
}

section('§9 what the part tells the others each time it reads')
{
  const { live, world, seen } = part({ tailHeld: true })
  live.recomputeLive()
  check('at rest a tail still held is cleared at this moment, and a running fold is dropped', j(seen.clearTail) === j([clock]) && seen.dropFold === 1)
  world.tailHeld = false
  live.recomputeLive()
  check('with no tail held nothing is cleared', seen.clearTail.length === 1 && seen.dropFold === 2)
  world.busy = true
  world.tailHeld = true
  live.recomputeLive()
  check('in flight the tail and the fold are left alone', seen.clearTail.length === 1 && seen.dropFold === 2)
  check('the feeds and the turn completion are told each time whether a turn is in flight', j(seen.cadence) === j([false, false, true]) && j(seen.steps) === j([false, false, true]), j({ cadence: seen.cadence, steps: seen.steps }))
  const held = live.live()
  const wakes = seen.wakes
  live.recomputeLive()
  const quiet = live.live() === held && seen.wakes === wakes
  world.completionAdvances = true
  live.recomputeLive()
  check('a turn completion that moved wakes the listeners with a fresh answer, though nothing else changed', quiet && live.live() !== held && j(live.live()) === j(held) && seen.wakes === wakes + 1, j({ quiet, wakes: seen.wakes - wakes }))
  const count = seen.wakes
  live.wake()
  check('the door can wake the listeners itself', seen.wakes === count + 1)
  let heard = 0
  const leave = live.subscribeLive(() => void heard++)
  live.wake()
  leave()
  live.wake()
  check('a listener that leaves hears nothing more', heard === 1)
}

g.setInterval = real.setInterval
g.clearInterval = real.clearInterval
Date.now = real.now
rmSync(plane, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-connector-live-part: the live part holds' : `\nprove-connector-live-part: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
