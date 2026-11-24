#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const at = (rel: string): string => join(ROOT, rel)

let failures = 0
const DRIVER_PORTS_FAIL_HINT = 'change printDriverPorts, advisorRoadOf, landAdvisorQuiet, startRunnerIdleNudge or carriersOf in src/daemon/runner/runnerDriver.ts (the runner state is in src/daemon/runner/runnerPorts.ts) so the behaviour in the label holds'
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond ? ` — ${DRIVER_PORTS_FAIL_HINT}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (value: unknown): string => JSON.stringify(value)
const UNSETTLED = Symbol('unsettled')
const within = <T,>(work: Promise<T> | T, ms = 3_000): Promise<T | typeof UNSETTLED> => Promise.race([Promise.resolve(work), new Promise<typeof UNSETTLED>(done => setTimeout(() => done(UNSETTLED), ms))])
setTimeout(() => {
  console.log('  [FAIL] the proof ended within its two minutes — a port awaited in a section never settled; the last section printed above says which, look at the matching function in src/daemon/runner/runnerDriver.ts')
  process.exit(1)
}, 120_000).unref()

type Call = { name: string; args: unknown[]; phases?: string[] }
const seen: Call[] = []
const answers = new Map<string, (...args: unknown[]) => unknown>()
const said = (name: string): Call[] => seen.filter(call => call.name === name)
const names = (): string[] => seen.map(call => call.name)
const order = (...wanted: string[]): boolean => {
  const at = wanted.map(name => names().indexOf(name))
  return at.every((index, i) => index !== -1 && (i === 0 || index > at[i - 1]!))
}
const phases = await import('../../src/platform/logs/runPhases.ts')
const stamped = (): string[] => phases.runPhaseReport(0).phases.map(entry => entry.phase)
const spy =
  (name: string) =>
  (...args: unknown[]): unknown => {
    seen.push({ name, args, phases: stamped() })
    return answers.get(name)?.(...args)
  }

async function spied(rel: string, wanted: string[], more: (real: Record<string, unknown>) => Record<string, unknown> = () => ({})): Promise<void> {
  const real = (await import(at(rel))) as Record<string, unknown>
  mock.module(at(rel), () => ({ ...real, ...Object.fromEntries(wanted.map(name => [name, spy(name)])), ...more(real) }))
}

await spied('src/models/advisor/index.ts', ['advisorMainTurnSettled', 'createAdvisorQuietMessage'])
await spied('src/sessions/transcripts/writer.ts', ['recordTranscript'])
await spied('src/daemon/runner/messageQueueManager.ts', ['enqueue', 'getCommandQueue'])
await spied('src/platform/logs/headlessProfiler.ts', ['logHeadlessProfilerTurn', 'headlessProfilerStartTurn'])
await spied('src/sessions/mneme/exitHandoff.ts', ['leaveNoteBeforeExit', 'exitNoteDue'])
await spied('src/integrations/event-hooks/background.ts', ['endBackgroundHooks'])
await spied('src/integrations/skill-watch/skillChangeDetector.ts', [], real => ({ skillChangeDetector: { ...(real.skillChangeDetector as object), dispose: spy('skillChangeDetector.dispose') } }))
await spied('src/platform/logs/debugLog.ts', ['logForDebugging'])
await spied('src/platform/processes/gracefulShutdown.ts', ['gracefulShutdown', 'isShuttingDown'])
await spied('src/sessions/notices/idleNudge.ts', ['startIdleNudge'])
await spied('src/tools/monitor/laneWall.ts', ['sessionLaneWall'])
await spied('src/engine/task-framework/taskRegistry.ts', ['getRunningTasks'])
await spied('src/tools/crewmate/crewmateLifecycle.ts', ['crewmateNoticeOwed'])
await spied('src/boot/process-state/processState.ts', ['getTotalAPIDuration'])

const driver = await import('../../src/daemon/runner/runnerDriver.ts')
const { createRunnerState } = await import('../../src/daemon/runner/runnerPorts.ts')
const { getSessionId, setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
const { getEngineModel } = await import('../../src/models/catalogue/engineModel.ts')
const { HANDOFF_ASK_BUDGET_MS } = await import('../../src/sessions/mneme/handoffAsk.ts')
const { OUTCOME_SENTENCES } = await import('../../src/engine/rows/vocabulary.ts')
const { MAIN_THREAD_AGENT, nudgeWords } = await import('../../src/sessions/notices/idleNudge.ts')
const { statusListeners } = await import('../../src/models/roads/anthropic/anthropicLimits.ts')
const { EMPTY_USAGE } = await import('../../src/engine/request-parts/emptyUsage.ts')

type Ports = Parameters<typeof driver.runnerDriverPorts>[0]
type Scene = { ports: Ports; live: Ports['live']; messages: unknown[]; rows: Array<Record<string, unknown>>; out: Array<Record<string, unknown>>; advisorRoad: unknown; rateLimitListener: () => void }

function scene(given: Record<string, unknown> = {}): Scene {
  seen.length = 0
  answers.clear()
  answers.set('getRunningTasks', () => [])
  answers.set('crewmateNoticeOwed', () => false)
  answers.set('isShuttingDown', () => false)
  answers.set('sessionLaneWall', () => ({ closed: false }))
  answers.set('getCommandQueue', () => [])
  answers.set('getTotalAPIDuration', () => 4_321)
  answers.set('endBackgroundHooks', async () => {})
  answers.set('recordTranscript', async () => {})
  const live = createRunnerState()
  const messages: unknown[] = []
  const rows: Array<Record<string, unknown>> = []
  const out: Array<Record<string, unknown>> = []
  const advisorRoad = { onQuiet: () => {} }
  const rateLimitListener = (): void => {}
  const recorder = (name: string): unknown =>
    new Proxy(function () {}, {
      apply: (_target, _self, args: unknown[]) => void seen.push({ name: `port:${name}`, args, phases: stamped() }),
      get: (_target, key) => (typeof key === 'symbol' || key === 'then' ? undefined : recorder(`${name}.${key}`)),
    })
  const held: Record<string, unknown> = {
    live,
    messages,
    advisorRoad,
    rateLimitListener,
    maxTime: undefined,
    isConcourseWorker: false,
    bootReady: Promise.resolve(),
    getAppState: () => ({ tasks: {} }),
    enqueueRow: (row: Record<string, unknown>) => void rows.push(row),
    liveScope: () => ({ session_id: 'the-session' }),
    isLocalShellTask: (task: { type?: string }) => task.type === 'local_bash',
    io: { outbound: { enqueue: (line: Record<string, unknown>) => void out.push(line), done: spy('port:io.outbound.done') } },
    ...given,
  }
  const made = new Map<string, unknown>()
  const ports = new Proxy(held, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      if (!made.has(key)) made.set(key, recorder(key))
      return made.get(key)
    },
  }) as unknown as Ports
  return { ports, live, messages, rows, out, advisorRoad, rateLimitListener }
}
setIsInteractive(false)

section('§1 the advisor at the turn\'s end and inside a turn')
{
  const s = scene()
  const built = driver.runnerDriverPorts(s.ports)
  const command = { value: 'the words', mode: 'prompt' }
  s.live.turnReachedModel = true
  built.onTurnSettled?.(command as never)
  const told = said('advisorMainTurnSettled')[0]?.args
  s.live.turnReachedModel = false
  built.onTurnSettled?.(command as never)
  check("the main chat's turn end: the driver's onTurnSettled takes the advisor's main road with the session's own message list — no queued prompt, no kick of the driver (red on the base: enqueue + driver.kick)", told?.[0] === String(getSessionId()) && told[1] === command && told[2] === s.messages && told[3] === s.advisorRoad && said('advisorMainTurnSettled').length === 1 && said('enqueue').length === 0 && !names().some(name => name.startsWith('port:driver')) && order('logHeadlessProfilerTurn', 'headlessProfilerStartTurn', 'advisorMainTurnSettled'), j(names()))
  check('a turn that never reached the model tells the advisor nothing', said('advisorMainTurnSettled').length === 1 && said('logHeadlessProfilerTurn').length === 2)

  const r = scene()
  const road = driver.advisorRoadOf(r.ports)
  const quiet = { id: 'quiet-1' }
  road.onQuiet(quiet as never)
  const landedNow = said('port:landAdvisorQuiet').length
  r.live.inFlightAbort = new AbortController()
  road.onQuiet({ id: 'quiet-2' } as never)
  const held = [...r.live.deferredAdvisorQuiet]
  r.live.inputClosed = true
  road.onQuiet({ id: 'quiet-3' } as never)
  check("a quiet round on the main chat lands a display-only row, never a queued prompt: landed now when no turn is open, else held to the turn's end, and dropped once the host is gone", landedNow === 1 && said('port:landAdvisorQuiet')[0]?.args[0] === quiet && said('port:landAdvisorQuiet').length === 1 && j(held) === j([{ id: 'quiet-2' }]) && r.live.deferredAdvisorQuiet.length === 1 && said('enqueue').length === 0, `${landedNow} · ${j(held)} · ${r.live.deferredAdvisorQuiet.length}`)

  const l = scene()
  const row = { type: 'system', uuid: 'the-quiet-row' }
  answers.set('createAdvisorQuietMessage', () => row)
  driver.landAdvisorQuiet(quiet as never, l.ports)
  const recorded = said('recordTranscript')[0]?.args
  check('the lander pushes the system row into the session list and records it on the transcript at once — the interactive chat paints from that record', l.messages.length === 1 && l.messages[0] === row && said('createAdvisorQuietMessage')[0]?.args[0] === quiet && j(recorded?.[0]) === j([row]) && recorded?.[1] === undefined && recorded?.[2] === l.messages, j(recorded?.[0]))
  answers.set('recordTranscript', async () => Promise.reject(new Error('the disk is full')))
  driver.landAdvisorQuiet(quiet as never, l.ports)
  await new Promise(done => setTimeout(done, 20))
  check('a quiet row the transcript refuses is logged and still stands in the session list', l.messages.length === 2 && said('logForDebugging').some(call => String(call.args[0]).includes('the quiet row was not recorded — the disk is full')))
}

section('§2 the rows the driver asks the runner for')
{
  const s = scene()
  const built = driver.runnerDriverPorts(s.ports)
  s.live.turnsRun = 4
  s.live.activeModel = 'the-seat-model'
  const opened = built.openTurnRow?.(['m-1', 'm-2']) as Record<string, unknown>
  const minted = s.live.currentTurnId
  const again = built.turnIdOf?.()
  s.live.currentTurn = 5
  s.live.activeModel = undefined
  const inTurn = built.openTurnRow?.([]) as Record<string, unknown>
  check('the runner mints the open row through the owner when the driver asks for one', opened.type === 'turn' && opened.state === 'started' && typeof minted === 'string' && opened.turn_id === minted && again === minted && j(opened.message_ids) === j(['m-1', 'm-2']) && opened.model === 'the-seat-model' && opened.turn === 4 && opened.session_id === getSessionId() && inTurn.turn === 5 && inTurn.turn_id === minted && inTurn.model === getEngineModel(), j([opened, inTurn]))
  built.onTurnStart?.()
  check('a new turn starts with no id until one is asked for', s.live.currentTurnId === null && typeof built.turnIdOf?.() === 'string' && s.live.currentTurnId !== minted)
  built.onAgentWait?.(3, 'the-waiting-turn')
  check('the runner relays the agent wait as a turn row ({ state: waiting, agents: n })', s.rows.length === 1 && s.rows[0]!.type === 'turn' && s.rows[0]!.state === 'waiting' && s.rows[0]!.agents === 3 && s.rows[0]!.turn_id === 'the-waiting-turn' && s.rows[0]!.turn === 4, j(s.rows))
  const failed = built.onCycleError?.(new Error('the second turn failed'), 'the-failed-turn') as Record<string, unknown> & { error?: { message?: string; class?: string } }
  s.live.currentTurn = null
  s.live.turnsRun = 0
  const first = built.onCycleError?.(new Error('before any turn'), 't') as Record<string, unknown>
  check('the real print error callback keeps the failed turn ordinal and identity: the turn in flight, else the count, turn 1 at least', failed.type === 'outcome' && failed.status === 'failed' && failed.turn === 5 && failed.turn_id === 'the-failed-turn' && failed.error?.message === 'the second turn failed' && failed.error.class === 'internal' && first.turn === 1, j([failed.turn, first.turn]))

  const limited = scene({ maxTime: { limitMs: 60_000, at: Date.now() - 1 } })
  const late = driver.runnerDriverPorts(limited.ports)
  late.enqueueOutput({ type: 'outcome', status: 'completed', answer: 'done' } as never)
  late.enqueueOutput({ type: 'outcome', status: 'failed' } as never)
  late.enqueueOutput({ type: 'text', text: 'words' } as never)
  const early = scene({ maxTime: { limitMs: 60_000, at: Date.now() + 60_000 } })
  driver.runnerDriverPorts(early.ports).enqueueOutput({ type: 'outcome', status: 'completed' } as never)
  check('a turn that completes after the run\'s time is up ends as time_limit with the limit\'s sentence; any other row passes as it is', limited.out[0]!.status === 'time_limit' && j(limited.out[0]!.error) === j({ class: 'time_limit', message: OUTCOME_SENTENCES.time_limit({ maxTimeMs: 60_000 }) }) && limited.out[0]!.answer === 'done' && limited.out[1]!.status === 'failed' && limited.out[2]!.type === 'text' && early.out[0]!.status === 'completed', j(limited.out))

  const p = scene({ executeTurn: async (_command: unknown, _batch: unknown, onMessage: (row: unknown) => void) => void [{ type: 'block_start' }, { type: 'text' }, { type: 'reasoning' }, { type: 'tool_call' }, { type: 'outcome' }].forEach(onMessage) })
  const got: unknown[] = []
  await driver.runnerDriverPorts(p.ports).executeTurn({} as never, [], row => void got.push(row), undefined)
  check('the party feed is told of each block that opens and each row that lands, and every row still reaches the driver', said('port:party.blockOpen').length === 1 && said('port:party.landed').length === 3 && got.length === 5, j(names()))

  const w = scene({ swarmResumes: { hasPending: () => false, waitingSeats: () => 0 } })
  const waits = driver.runnerDriverPorts(w.ports)
  answers.set('getRunningTasks', () => [{ type: 'local_bash' }, { type: 'local_agent' }])
  const open = [waits.hasWaitableBackgroundTasks?.(), waits.waitableBackgroundTaskCount?.(), waits.hasHoldableBackgroundAgents?.()]
  w.live.inputClosed = true
  const closed = [waits.hasWaitableBackgroundTasks?.(), waits.waitableBackgroundTaskCount?.()]
  answers.set('getRunningTasks', () => [{ type: 'local_bash' }])
  const shellsOnly = [waits.hasWaitableBackgroundTasks?.(), waits.waitableBackgroundTaskCount?.()]
  check('once the input is closed a shell left running is nothing to wait for, and a crewmate still is', j(open) === j([true, 2, true]) && j(closed) === j([true, 1]) && shellsOnly[0] !== true && shellsOnly[1] === 0, j([open, closed, shellsOnly]))
}

section('§3 the close of the output')
{
  const s = scene()
  const built = driver.runnerDriverPorts(s.ports)
  statusListeners.add(s.rateLimitListener as never)
  phases._resetRunPhasesForTesting()
  await within(built.closeOutput())
  check('run.ts disarms on the session-end road beside the skills detector dispose (both before the output closes)', order('endBackgroundHooks', 'skillChangeDetector.dispose', 'port:disarmAgentFreshness', 'port:stopDrainedNotificationFrames', 'port:stopSdkDrain', 'port:io.outbound.done') && names().at(-1) === 'port:io.outbound.done' && !statusListeners.has(s.rateLimitListener as never), j(names()))
  const report = said('logForDebugging').map(call => String(call.args[0])).find(line => line.startsWith('[run-phases] '))
  const shipped = report === undefined ? null : (JSON.parse(report.slice('[run-phases] '.length)) as { phases: Array<{ phase: string }>; providerApiMs: number })
  check('F02 wiring: the report ships at the close of the output with the api-duration ledger figure, after the flush stamp and before the output is done', shipped !== null && shipped.providerApiMs === 4_321 && shipped.phases.some(entry => entry.phase === 'flush_exit') && (said('port:io.outbound.done')[0]?.phases ?? []).includes('flush_exit') && !(said('port:stopSdkDrain')[0]?.phases ?? []).includes('flush_exit'), String(report))

  const c = scene()
  answers.set('exitNoteDue', () => true)
  answers.set('leaveNoteBeforeExit', async options => {
    const given = options as { onNotice: (text: string) => void; onUsage: (usage: unknown) => void }
    given.onNotice('the note could not be stored')
    given.onUsage(EMPTY_USAGE)
    return 'stored'
  })
  await within(driver.runnerDriverPorts(c.ports).beforeCloseOutput?.())
  const ask = said('leaveNoteBeforeExit')[0]?.args[0] as { budgetMs?: number } | undefined
  check('run wires the ask to the shared final-close port', said('leaveNoteBeforeExit').length === 1 && ask?.budgetMs === HANDOFF_ASK_BUDGET_MS && c.out.length === 2 && c.out[0]!.type === 'notice' && c.out[0]!.level === 'warning' && c.out[0]!.text === 'the note could not be stored' && c.out[1]!.type === 'close' && c.out[1]!.state === 'stored' && 'usage' in c.out[1]!, j(c.out))
  const nothingDue = scene()
  answers.set('exitNoteDue', () => false)
  answers.set('leaveNoteBeforeExit', async () => 'none')
  await within(driver.runnerDriverPorts(nothingDue.ports).beforeCloseOutput?.())
  const hosted = scene({ isConcourseWorker: true })
  await within(driver.runnerDriverPorts(hosted.ports).beforeCloseOutput?.())
  check('a run with no note due writes no close row, and a seat the daemon hosts leaves no note at the close of its output', nothingDue.out.length === 0 && said('leaveNoteBeforeExit').length === 0 && hosted.out.length === 0)
}

section('§4 the idle nudge')
{
  let running = false
  let ended = 0
  const s = scene({ driver: { isRunning: () => running, endOperatorWait: () => void ended++ }, carriersOf: () => [] })
  const handle = { stop: () => {} }
  answers.set('startIdleNudge', () => handle)
  const started = driver.startRunnerIdleNudge(s.ports)
  const nudge = said('startIdleNudge')[0]?.args[0] as { recipient: (id: string) => { state: string; why?: string }; wake: (id: string, notices: unknown[]) => boolean; discard: (notices: unknown[]) => void }
  const states: Record<string, unknown> = {}
  states['before the first words'] = nudge.recipient(MAIN_THREAD_AGENT)
  s.live.sessionInitialized = true
  states.idle = nudge.recipient(MAIN_THREAD_AGENT)
  running = true
  states['a turn running'] = nudge.recipient(MAIN_THREAD_AGENT)
  running = false
  answers.set('sessionLaneWall', () => ({ closed: true }))
  states['the wall closed'] = nudge.recipient(MAIN_THREAD_AGENT)
  s.live.inputClosed = true
  states['the input closed'] = nudge.recipient(MAIN_THREAD_AGENT)
  answers.set('isShuttingDown', () => true)
  states['shutting down'] = nudge.recipient(MAIN_THREAD_AGENT)
  check(
    'N6 the session runner starts the idle nudge with the main thread and its agents as recipients',
    started === handle && j(states) === j({ 'before the first words': { state: 'busy' }, idle: { state: 'idle' }, 'a turn running': { state: 'busy' }, 'the wall closed': { state: 'busy' }, 'the input closed': { state: 'gone', why: "the session's input closed" }, 'shutting down': { state: 'gone', why: 'the session is shutting down' } }) && typeof nudge.recipient('an-agent-nobody-runs').state === 'string',
    j(states),
  )
  const notices = [{ key: 'n-1', deliveredAtMs: Date.now() - 5_000, summary: 'a crewmate finished' }]
  const woke = nudge.wake(MAIN_THREAD_AGENT, notices)
  const queued = said('enqueue')[0]?.args[0] as Record<string, unknown> | undefined
  check('N6 the runner wakes the main thread through its own queue, behind the notices', woke === true && queued?.mode === 'prompt' && queued.priority === 'later' && queued.isMeta === true && typeof queued.uuid === 'string' && typeof queued.value === 'string' && queued.value === nudgeWords(notices as never, 5_000).replace(/\d+ ?(?:s|seconds?)/, match => match) && String(queued.value).length > 0, j(queued))
  check("the idle nudge's wake queues the nudge and opens the driver's door on the operator wait", ended === 1 && said('enqueue').length === 1, `${ended} · ${said('enqueue').length}`)
  const agentWoke = nudge.wake('an-agent', notices)
  const carriers = [{ queueId: 'n-1' }]
  nudge.discard(notices)
  const retiredWithNone = said('port:retireQueuedCommands').length
  const d = scene({ driver: { isRunning: () => false, endOperatorWait: () => {} }, carriersOf: () => carriers })
  answers.set('startIdleNudge', () => handle)
  driver.startRunnerIdleNudge(d.ports)
  ;(said('startIdleNudge')[0]?.args[0] as typeof nudge).discard(notices)
  check("N6 the nudge wakes the main thread alone — an agent's notices wait for its next tool boundary — and the discarded carriers leave through the runner's own retire door, which speaks no completion frame", agentWoke === false && ended === 1 && retiredWithNone === 0 && said('port:retireQueuedCommands').length === 1 && said('port:retireQueuedCommands')[0]?.args[0] === carriers, `${agentWoke} · ${retiredWithNone} · ${said('port:retireQueuedCommands').length}`)
  scene()
  answers.set('getCommandQueue', () => [{ queueId: 'n-1' }, { uuid: 'alt-2' }, { queueId: 'other' }, { uuid: 'u-9' }])
  const found = driver.carriersOf([{ key: 'n-1' }, { key: 'k-2', altKey: 'alt-2' }] as never)
  check('the carriers of a notice are the queued commands under its key or its other key, by queue id or by uuid', j(found) === j([{ queueId: 'n-1' }, { uuid: 'alt-2' }]), j(found))
}

console.log(failures === 0 ? '\nprove-turn-driver-ports: green' : `\nprove-turn-driver-ports: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
