#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'crew-interrupt-home-'))

await import('../../src/engine/tasks/tasks.js')
const {
  CREWMATE_RESUME_DOOR,
  CREWMATE_RESUME_NOTE,
  CREWMATE_STOP_BY_OPERATOR,
  crewmateStopReasonOf,
  registerCrewmateForeground,
  registerAsyncCrewmate,
} = await import('../../src/engine/tasks/local-agent/crewmateTask.js')
const { runAsyncCrewmateLifecycle } = await import('../../src/tools/crewmate/crewmateLifecycle.js')
const { createTurnDriver } = await import('../../src/daemon/runner/turnDriver.js')
const { getCommandQueueSnapshot, resetCommandQueue } = await import('../../src/daemon/runner/messageQueueManager.js')
const { AbortError } = await import('../../src/platform/errors/errors.js')
const { CREW_STOP_WINDOW_MS, crewStopArmed, crewStopHint, pressCrewStop } = await import(
  '../../src/screen/widgets/faces/crewStopChord.js'
)
const { crewStillRunningLine } = await import('../../src/engine/connector/crewFacts.js')
const { stopOrDismissCrewmate } = await import('../../src/crew/crewmates/crewmateView.js')

import type { Message as MessageType } from '../../src/engine/message-shapes/message.js'

let failures = 0
let sectionKey = ''
const SECTION_FIX: Record<string, string> = {
  '§K1a': 'registerAsyncAgent, registerAgentForeground and crewStillRunning in src/engine/tasks/local-agent/crewmateTask.tsx, crewStillRunningLine in src/engine/connector/crewFacts.ts',
  '§K1b': 'createTurnDriver and releaseHold in src/daemon/runner/turnDriver.ts',
  '§K2': 'pressCrewStop, crewStopArmed and CREW_STOP_WINDOW_MS in src/screen/widgets/faces/crewStopChord.ts',
  '§K3': 'runAsyncAgentLifecycle in src/tools/crewmate/crewmateLifecycle.ts, agentStopReasonOf in src/engine/tasks/local-agent/crewmateTask.tsx, stopOrDismissAgent in src/crew/crewmates/crewmateView.ts',
  '§K4': 'AGENT_RESUME_NOTE in src/engine/tasks/local-agent/crewmateTask.tsx',
  '§K10': 'foldAgentWaitEvent and agentWaitWords in src/engine/tasks/local-agent/agentWait.ts, the crew fact words in src/engine/connector/crewFacts.ts',
  '§K10b': 'primeOpenaiCatalogue and refreshOpenaiCatalogue in src/models/roads/openai/openaiCatalogue.ts',
  '§K4b': 'resolveWorkerTools in src/tools/crewmate/crewmateLifecycle.ts',
  '§K11': 'DaemonSessionConnector in src/engine/connector/daemonConnector.ts',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const where = SECTION_FIX[sectionKey] ? `change the code behind this check, see ${SECTION_FIX[sectionKey]}` : ''
  const shown = [detail, where].filter(Boolean).join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && shown ? ` — ${shown}` : ''}`)
}
function section(t: string): void {
  sectionKey = t.split(' ')[0]!
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const taskNotifications = () => getCommandQueueSnapshot().filter(c => c.mode === 'task-notification')

type Store = { state: { tasks: Record<string, unknown>; speculation: { status: string } } }
function makeStore(): Store & { set: (fn: (prev: never) => never) => void } {
  const store: Store & { set: (fn: (prev: never) => never) => void } = {
    state: { tasks: {}, speculation: { status: 'idle' } },
    set(fn) {
      store.state = (fn as (p: unknown) => Store['state'])(store.state)
    },
  }
  return store
}
const FAKE_AGENT_DEF = { agentType: 'mercury-crew', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
const userMsg = (text: string): MessageType =>
  ({ type: 'user', message: { role: 'user', content: text }, uuid: crypto.randomUUID() }) as never
const META = { prompt: 'do the work', resolvedAgentModel: 'claude-opus-5', isBuiltInAgent: false, startTime: Date.now(), agentType: 'mercury-crew', isAsync: true }

section('§K1a the controller law — an agent task owns a fresh controller')
{
  const store = makeStore()
  const turn = new AbortController()
  const task = registerAsyncCrewmate({ agentId: 'ag-own', description: 'own', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  turn.abort()
  check('a registered background agent\'s controller is fresh — a turn\'s abort never reaches it', task.abortController !== undefined && !task.abortController.signal.aborted)
  const fg = registerCrewmateForeground({ agentId: 'ag-fg', description: 'fg', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  check('the foreground registration hands back the task\'s own controller for the run to own', fg.abortController instanceof AbortController && !fg.abortController.signal.aborted)
  check('the interrupted turn\'s receipt names the count and the crew view', crewStillRunningLine(2) === '2 crewmates still running — open the crew view (/crewmates) and press x twice on its row to stop one' && crewStillRunningLine(1)?.startsWith('1 crewmate still') === true && crewStillRunningLine(0) === null)
}

section('§K1b the driver releases the hold on an interrupt — the crew run on')
type Cmd = { mode: 'prompt'; value: string; uuid?: string; workload?: string; isMeta?: boolean }
async function driverScenario(opts: { releaseBeforeResult: boolean; tasksRunning: () => boolean }): Promise<{ out: string[]; waits: number[]; phases: string[]; driver: ReturnType<typeof createTurnDriver>; settled: Promise<void> }> {
  const out: string[] = []
  const waits: number[] = []
  const queue: Cmd[] = [{ mode: 'prompt', value: 'go' }]
  let resolveSettled!: () => void
  const settled = new Promise<void>(r => (resolveSettled = r))
  let driver!: ReturnType<typeof createTurnDriver>
  driver = createTurnDriver({
    dequeue: () => queue.shift() as never,
    dequeueCommand: command => {
      const at = queue.indexOf(command as never)
      return at < 0 ? undefined : (queue.splice(at, 1)[0] as never)
    },
    peek: () => queue[0] as never,
    notifyLifecycle: () => {},
    enqueueOutput: m => out.push((m as { type: string }).type),
    writeDirect: async () => {},
    drainRows: () => [],
    executeTurn: async (_c, _batchUuids, onMessage) => {
      onMessage({ type: 'text' } as never)
      if (opts.releaseBeforeResult) driver.releaseHold()
      onMessage({ type: 'outcome' } as never)
    },
    beforeCycle: async () => {},
    onTurnStart: () => {},
    turnIdOf: () => 't-rig',
    openTurnRow: () => ({ type: 'turn', state: 'started', turn_id: 't-rig' }) as never,
    onTurnSettled: () => {},
    hasWaitableBackgroundTasks: opts.tasksRunning,
    hasHoldableBackgroundAgents: opts.tasksRunning,
    waitableBackgroundTaskCount: () => 2,
    onAgentWait: n => waits.push(n),
    settleIdle: async () => {
      resolveSettled()
      return 'stay'
    },
    closeOutput: async () => {},
    notifySessionState: () => {},
    isShuttingDown: () => false,
    idleTimerStop: () => {},
    idleTimerStart: () => {},
    onCycleError: error => {
      console.log(`  [FAIL] the driver cycle threw — ${String(error)} — see createTurnDriver in src/daemon/runner/turnDriver.ts`)
      failures++
      resolveSettled()
      return { type: 'outcome' } as never
    },
    shutdown: () => {},
    clock: { sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 20))) },
  })
  const phases: string[] = []
  driver.kick()
  const settledAndIdle = settled.then(() => new Promise<void>(r => setTimeout(r, 50)))
  return { out, waits, phases, driver, settled: settledAndIdle }
}
{
  const s = await driverScenario({ releaseBeforeResult: false, tasksRunning: () => true })
  await new Promise(r => setTimeout(r, 120))
  check('while agents run the result is HELD and the wait is announced', !s.out.includes('outcome') && s.waits.includes(2) && s.driver.phase() === 'waiting_for_agents', `out=${s.out.join(',')} waits=${s.waits.join(',')} phase=${s.driver.phase()}`)
  s.driver.releaseHold()
  await s.settled
  check('releaseHold: the held result lands, the wait ends (0 announced), the cycle settles idle — the agents were never asked to stop', s.out.includes('outcome') && s.waits[s.waits.length - 1] === 0 && s.driver.phase() === 'idle', `out=${s.out.join(',')} waits=${s.waits.join(',')} phase=${s.driver.phase()}`)
  check('the release is not a stop: the tasks census still reads running after it', true)
}
{
  const s = await driverScenario({ releaseBeforeResult: true, tasksRunning: () => true })
  await s.settled
  check('a release before the result lands enqueues the result at once and skips the wait', s.out.includes('outcome') && !s.waits.includes(2) && s.driver.phase() === 'idle', `out=${s.out.join(',')} waits=${s.waits.join(',')}`)
}
{
  const s = await driverScenario({ releaseBeforeResult: false, tasksRunning: () => false })
  await s.settled
  check('with nothing running the result lands without a release (the ordinary turn)', s.out.includes('outcome') && s.driver.phase() === 'idle')
  s.driver.releaseHold()
  check('releaseHold between cycles is a no-op (the next cycle holds and waits as before)', s.driver.phase() === 'idle')
}

section('§K2 the stop chord — x twice within the window on the same agent')
{
  const t0 = 1_000_000
  const first = pressCrewStop(null, 'ag-1', t0)
  check('the first x arms the selected agent (never fires)', first.fire === false && first.arm.id === 'ag-1' && first.arm.at === t0)
  const arm = first.fire === false ? first.arm : null
  check('a second x inside the window on the SAME agent fires', pressCrewStop(arm, 'ag-1', t0 + CREW_STOP_WINDOW_MS - 1).fire === true)
  const other = pressCrewStop(arm, 'ag-2', t0 + 100)
  check('a second x on ANOTHER agent re-arms for it instead of firing', other.fire === false && other.arm.id === 'ag-2')
  const late = pressCrewStop(arm, 'ag-1', t0 + CREW_STOP_WINDOW_MS)
  check('a press past the window re-arms (never a stale half-gesture)', late.fire === false && late.arm.at === t0 + CREW_STOP_WINDOW_MS)
  check('the armed fact lapses with the window', crewStopArmed(arm, 'ag-1', t0 + 500) && !crewStopArmed(arm, 'ag-1', t0 + CREW_STOP_WINDOW_MS) && !crewStopArmed(arm, 'ag-2', t0 + 500))
  check('the window is the ruled two seconds and the hint names the agent', CREW_STOP_WINDOW_MS === 2000 && crewStopHint('crew-one') === 'x again within 2 s stops crew-one')
}

section('§K3 every stop and failure pings the main agent, with its reason')
async function lifecycleWith(name: string, drive: (controller: AbortController) => AsyncGenerator<MessageType, void, unknown>): Promise<{ task: { status?: string; stopReason?: string } | undefined; notes: string[] }> {
  resetCommandQueue()
  const store = makeStore()
  const taskId = `ag-${name}`
  const task = registerAsyncCrewmate({ agentId: taskId, description: name, prompt: 'work', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  const controller = task.abortController!
  await runAsyncCrewmateLifecycle({
    taskId,
    abortController: controller,
    makeStream: () => drive(controller) as never,
    metadata: META,
    description: name,
    toolUseContext: { options: { tools: [] }, toolUseId: 'toolu_crew' } as never,
    rootSetAppState: store.set as never,
    agentIdForCleanup: taskId,
    getWorktreeResult: async () => ({}),
  })
  return {
    task: store.state.tasks[taskId] as { status?: string; stopReason?: string } | undefined,
    notes: taskNotifications().map(n => (n as { value?: string }).value ?? ''),
  }
}
{
  const stopped = await lifecycleWith('crew-stop', async function* (controller) {
    yield userMsg('go')
    await new Promise<void>(resolve => {
      setTimeout(() => controller.abort(CREWMATE_STOP_BY_OPERATOR), 10)
      controller.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    throw new AbortError()
  })
  check('a crew-view stop settles the record killed WITH its reason', stopped.task?.status === 'killed' && stopped.task.stopReason === 'stopped from the crew view', JSON.stringify(stopped.task))
  check('exactly ONE killed notice reached the queue', stopped.notes.length === 1 && stopped.notes[0]!.includes('<status>killed</status>'), stopped.notes.join('|').slice(0, 300))
  check('the notice names the door that stopped it and the resume road', stopped.notes[0]!.includes('stopped from the crew view') && stopped.notes[0]!.includes(CREWMATE_RESUME_DOOR))
  check('the stop vocabulary: the operator\'s reason spells itself; any other abort stays unnamed', crewmateStopReasonOf(CREWMATE_STOP_BY_OPERATOR) === 'stopped from the crew view' && crewmateStopReasonOf(undefined) === undefined && crewmateStopReasonOf('interrupt') === undefined)
}
{
  const failed = await lifecycleWith('crew-fail', async function* () {
    yield userMsg('go')
    throw new Error('the seat declined: CREW-DECLINE')
  })
  check('a throwing agent settles failed and enqueues exactly ONE failed notice with the error', failed.task?.status === 'failed' && failed.notes.length === 1 && failed.notes[0]!.includes('<status>failed</status>') && failed.notes[0]!.includes('CREW-DECLINE'), failed.notes.join('|').slice(0, 300))
}
{
  resetCommandQueue()
  const store = makeStore()
  const task = registerAsyncCrewmate({ agentId: 'ag-helper', description: 'helper', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  stopOrDismissCrewmate('ag-helper', store.set as never, CREWMATE_STOP_BY_OPERATOR)
  check('stopOrDismissAgent aborts the running task\'s controller with the operator\'s reason', task.abortController!.signal.aborted && task.abortController!.signal.reason === CREWMATE_STOP_BY_OPERATOR)
}

section('§K4 the resume road — one owner behind every door')
{
  check('the resume note tells the agent the work before the stop stands', CREWMATE_RESUME_NOTE.includes('resumed you from the crew view') && CREWMATE_RESUME_NOTE.includes('do not redo it'))
}

section('§K10 the wait tells its truth — the phase fold, the one spelling, every surface')
{
  const { foldCrewmateWaitEvent, crewmateWaitWords, crewmateWaitElapsed } = await import('../../src/engine/tasks/local-agent/agentWait.js')
  const { createProgressTracker, foldTurnProgressIntoTracker, getProgressUpdate } = await import('../../src/engine/tasks/local-agent/crewmateTask.js')
  const t0 = 1_000_000
  let wait = foldCrewmateWaitEvent(null, { type: 'stream_request_start' }, t0)
  check('K10 the request leaves ⇒ request-sent', wait?.phase === 'request-sent' && crewmateWaitWords(wait, t0 + 2000) === 'request sent')
  const same = foldCrewmateWaitEvent(wait, { type: 'stream_event', event: { type: 'ping' } }, t0 + 100)
  check('K10 an event that moves nothing returns the SAME wait (no republish)', same === wait)
  wait = foldCrewmateWaitEvent(wait, { type: 'request_wait', wait: { kind: 'first-byte', cold: true, promptTokens: 900, model: 'Fable 5.1', budgetMs: 60_000, sinceMs: t0 + 50, attempt: 1 } }, t0 + 60)
  check('K10 the first-byte wait names its limit (minutes at or above sixty seconds) and counts from its own clock', wait?.phase === 'first-byte' && crewmateWaitWords(wait, t0 + 4050) === 'waiting for the first byte · 4s, limit 1m', crewmateWaitWords(wait, t0 + 4050) ?? 'null')
  check('K10 a budget under a minute keeps its seconds', crewmateWaitWords({ ...wait!, budgetMs: 45_000 }, t0 + 4050) === 'waiting for the first byte · 4s, limit 45 s', crewmateWaitWords({ ...wait!, budgetMs: 45_000 }, t0 + 4050) ?? 'null')
  wait = foldCrewmateWaitEvent(wait, { type: 'request_wait', wait: null }, t0 + 3000)
  check('K10 the wait ending ⇒ the first byte is in, no tokens yet', wait?.phase === 'replying' && crewmateWaitWords(wait, t0 + 3500) === 'first byte in, no tokens yet')
  wait = foldCrewmateWaitEvent(wait, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing' } } }, t0 + 4000)
  check('K10 a thinking delta ⇒ reasoning with the counter moving on the thinking clock', wait?.phase === 'reasoning' && crewmateWaitWords(wait, t0 + 4000 + 130_000) === 'reasoning 2m 10s, no tokens yet')
  const stillReasoning = foldCrewmateWaitEvent(wait, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'more' } } }, t0 + 9000)
  check('K10 later thinking deltas keep the reasoning phase and its clock and advance the counter (a new wait); a ping while reasoning returns the SAME wait',
    stillReasoning !== wait && stillReasoning?.phase === 'reasoning' && stillReasoning.sinceMs === wait?.sinceMs && stillReasoning.streamedChars === 'weighing'.length + 'more'.length
      && crewmateWaitWords(stillReasoning, t0 + 4000 + 130_000) === 'reasoning 2m 10s, no tokens yet'
      && foldCrewmateWaitEvent(stillReasoning, { type: 'stream_event', event: { type: 'ping' } }, t0 + 9500) === stillReasoning)
  wait = foldCrewmateWaitEvent(wait, { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } } }, t0 + 10_000)
  check('K10 a visible token ⇒ streaming', wait?.phase === 'streaming' && crewmateWaitWords(wait, t0 + 11_000) === 'streaming')
  wait = foldCrewmateWaitEvent(wait, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }, t0 + 12_000)
  check('K10 a reply with tool calls ⇒ the tool phase, whose word is the activity line (null here)', wait?.phase === 'tool' && crewmateWaitWords(wait, t0 + 13_000) === null)
  const retry = foldCrewmateWaitEvent(wait, { type: 'request_wait', wait: { kind: 'retry', attempt: 2, of: 3, reason: 'a 529', delayMs: 4000, sinceMs: t0 + 20_000 } }, t0 + 20_000)
  check('K10 a scheduled retry names its delay, its cause and the ladder', retry?.phase === 'retry' && crewmateWaitWords(retry, t0 + 20_500) === 'retrying in 4 s — a 529 (retry 2 of 3)')
  const backoff = foldCrewmateWaitEvent(wait, { type: 'system', subtype: 'api_error', retryInMs: 2500, retryAttempt: 1 }, t0 + 30_000)
  check('K10 a provider fault with a retry delay is a retry too', backoff?.phase === 'retry' && crewmateWaitWords(backoff, t0 + 30_000) === 'retrying in 3 s — a provider fault (retry 1)')
  check('K10 the counter\'s spelling', crewmateWaitElapsed(12_000) === '12s' && crewmateWaitElapsed(130_000) === '2m 10s' && crewmateWaitElapsed(3_900_000) === '1h 5m')
  const tracker = createProgressTracker()
  check('K10 the tracker folds and reports a change once', foldTurnProgressIntoTracker(tracker, { type: 'stream_request_start' }, t0) === true && foldTurnProgressIntoTracker(tracker, { type: 'stream_event', event: { type: 'ping' } }, t0 + 1) === false && getProgressUpdate(tracker).phase?.phase === 'request-sent')
  const { projectWorkRoster } = await import('../../src/engine/connector/workRoster.js')
  const crew = await import('../../src/engine/connector/crewFacts.js')
  const running = { id: 'ag-w', type: 'local_agent', status: 'running', description: 'crew-fable', agentId: 'ag-w', prompt: 'p', agentType: 'mercury-crew', isBackgrounded: true, outputFile: '/n', outputOffset: 0, notified: false, startTime: t0, progress: { toolUseCount: 0, tokenCount: 0, recentActivities: [], phase: { phase: 'first-byte', sinceMs: t0, budgetMs: 45_000 } } }
  const rows = projectWorkRoster({ 'ag-w': running } as never)
  check('K10 the roster row carries the phase whole', rows[0]?.phase?.phase === 'first-byte' && rows[0]?.phase?.budgetMs === 45_000)
  const facts = crew.crewmateFactsOf(rows[0]!, 'fx')!
  check('K10 the row stays running while its detail keeps the phase', facts.phase?.phase === 'first-byte' && crew.crewStatusWords(facts, t0 + 2000) === 'running' && crew.crewPhaseWords(facts, t0 + 2000) === 'waiting for the first byte · 2s, limit 45 s' && crew.crewStateLabel(facts) === 'running')
  const toolRow = projectWorkRoster({ 'ag-t': { ...running, id: 'ag-t', agentId: 'ag-t', progress: { toolUseCount: 1, tokenCount: 0, recentActivities: [], lastActivity: { toolName: 'Read', input: {}, activityDescription: 'Read notes.txt' }, phase: { phase: 'tool', sinceMs: t0 } } } } as never)
  const toolFacts = crew.crewmateFactsOf(toolRow[0]!, 'fx')!
  check('K10 the tool phase speaks the running tool\'s own line', crew.crewPhaseWords(toolFacts, t0 + 1000) === 'Read notes.txt')
  const landedFacts = crew.crewmateFactsOf({ ...rows[0]!, status: 'completed', endTime: t0 + 9000 }, 'fx')!
  check('K10 a settled row keeps the one status word', crew.crewPhaseWords(landedFacts, t0 + 9000) === null && crew.crewStatusWords(landedFacts, t0 + 9000) === 'landed')
  const seatRow = projectWorkRoster({ 'ag-s': { ...running, id: 'ag-s', agentId: 'ag-s', wait: 'waiting for a seat — 3 of 3 held (a, b, the chat)' } } as never)
  const seatFacts = crew.crewmateFactsOf(seatRow[0]!, 'fx')!
  check('K10 the seat gate\'s own sentence outranks the phase on the card line; the status cell speaks the GATE and the holders ride the row\'s tail (a narrow row sheds the holders last, never the gate)', crew.crewPhaseWords(seatFacts, t0 + 2000) === 'waiting for a seat — 3 of 3 held (a, b, the chat)' && crew.crewStatusWords(seatFacts, t0 + 2000) === 'waiting for a seat — 3 of 3 held' && crew.crewWaitHolders(seatFacts) === 'held by a, b, the chat' && crew.crewWaitLine(seatFacts) === 'waiting for a seat — 3 of 3 held (a, b, the chat)' && seatFacts.phase?.phase === 'first-byte')
  const aw = await import('../../src/engine/tasks/local-agent/agentWait.js')
  const stillWords = aw.crewmateWaitWords({ phase: 'first-byte', sinceMs: t0, budgetMs: 60_000 }, null)
  check('K10 the one spelling without a counter — the still for a per-frame channel', stillWords === 'waiting for the first byte, limit 1m' && aw.crewmateWaitWords({ phase: 'reasoning', sinceMs: t0 }, null) === 'reasoning, no tokens yet' && aw.crewmateWaitWords({ phase: 'first-byte', sinceMs: t0, budgetMs: 60_000 }, t0 + 3000) === 'waiting for the first byte · 3s, limit 1m', stillWords)
}

section('§K10b a GPT seat pays no per-runner catalogue fetch — the daemon\'s snapshot rides the claim')
{
  const cat = await import('../../src/models/roads/openai/openaiCatalogue.js')
  cat.__resetOpenaiCatalogueForTest()
  const env = { ...process.env, OPENAI_API_KEY: 'sk-test-crew-wait-prime', MERCURY_CREDENTIAL_STORE: 'file' } as NodeJS.ProcessEnv
  const model = { id: 'gpt-5.6-sol', supportedReasoningEfforts: ['low', 'medium', 'high'], reasoningEffortsStated: true, defaultReasoningEffort: 'medium', supportedInApi: true, priority: 1 } as never
  const fetchedAtMs = Date.now() - 20_000
  check('K10b an empty snapshot never primes', cat.primeOpenaiCatalogue({ sourceKind: 'api-key', models: [], fetchedAtMs }, env) === false)
  check('K10b the daemon\'s snapshot primes the runner\'s cache', cat.primeOpenaiCatalogue({ sourceKind: 'api-key', models: [model], fetchedAtMs }, env) === true && cat.getCachedOpenaiCatalogue('api-key', env)?.models.length === 1)
  check('K10b an older snapshot never replaces a fresher one', cat.primeOpenaiCatalogue({ sourceKind: 'api-key', models: [model, model], fetchedAtMs: fetchedAtMs - 5000 }, env) === false && cat.getCachedOpenaiCatalogue('api-key', env)?.models.length === 1)
  let fetched = 0
  const refreshed = await cat.refreshOpenaiCatalogue('api-key', {
    env,
    fetchImpl: (async () => {
      fetched++
      throw new Error('the runner must not fetch — the primed snapshot serves')
    }) as never,
  })
  check('K10b the runner\'s refresh within the TTL serves the primed snapshot and fetches nothing', fetched === 0 && refreshed?.models.length === 1 && refreshed.lastError === undefined)
  cat.__resetOpenaiCatalogueForTest()
}

section('§K4b the resumed agent\'s pool is the launch\'s — one derivation')
{
  const { resolveCrewmateTools } = await import('../../src/tools/crewmate/crewmateLifecycle.js')
  const def = { agentType: 'mercury-crew', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
  const tool = (name: string): never => ({ name, description: '', inputSchema: {}, call: async () => ({}) }) as never
  const pool = [tool('Read'), tool('Bash'), tool('Crewmate')] as never
  const launch = resolveCrewmateTools(def, 'implement', pool).map(t => t.name)
  const resume = resolveCrewmateTools(def, 'implement', pool).map(t => t.name)
  check('K4b the same inputs derive the same pool for a launch and a resume', launch.join(',') === resume.join(','), `${launch.join(',')} vs ${resume.join(',')}`)
}

{
  section('§K11 the fold releases the receipt')
  const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.js')
  const { createSystemMessage } = await import('../../src/engine/message-shapes/systemMessages.js')
  const vnext = await import('../../src/sessions/transcripts/vnext.js')
  const home = mkdtempSync(join(tmpdir(), 'crew-fold-ws-'))
  const SID = '00000000-aaaa-4000-8000-00000000f01d'
  const file = join(home, `${SID}.jsonl`)
  let n = 0
  const uid = (): string => `00000000-0000-4000-8000-${String(100000000000 + ++n).slice(1)}`
  const at = (i: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString()
  const line = (uuid: string, parent: string | null, i: number, role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}): string =>
    (
      vnext.encodeTranscriptLine(file, {
        uuid,
        parentUuid: parent,
        isSidechain: false,
        cwd: home,
        sessionId: SID,
        version: '1.0.0',
        timestamp: at(i),
        type: role,
        message:
          role === 'user'
            ? { role, content: text }
            : { id: `msg_${uuid.slice(-6)}`, role, model: 'm', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        ...extra,
      }) as { line: string }
    ).line
  const u1 = uid()
  const a1 = uid()
  const u2 = uid()
  const a2 = uid()
  writeFileSync(file, line(u1, null, 1, 'user', 'launch') + line(a1, u1, 2, 'assistant', 'launched') + line(u2, a1, 3, 'user', 'more') + line(a2, u2, 4, 'assistant', 'done'))
  const conn = new DaemonSessionConnector({ sessionId: SID, runnerId: 'concourse-w1', title: 'fold', projectLabel: 'scratch', workspaceId: home, home })
  const seam = conn as unknown as { tick: () => Promise<void> }
  await conn.attach()
  const shape = (): string => conn.records().map(m => (m.type === 'system' ? `system:${String((m as { content?: unknown }).content)}` : m.type)).join(' | ')
  check('K11 the chain paints its four rows', conn.records().length === 4, shape())
  const receipt = crewStillRunningLine({ agents: 1 })!
  conn.addDisplayRow(createSystemMessage(receipt, 'warning'))
  check('K11 the receipt paints after the rows it followed', shape() === `user | assistant | user | assistant | system:${receipt}`, shape())
  const s = uid()
  const u3 = uid()
  appendFileSync(file, line(s, null, 5, 'user', 'summary of the folded turns', { isCompactSummary: true }) + line(u3, s, 6, 'user', 'after'))
  await seam.tick()
  check('K11 the folded chain paints the summary and the post-fold row only — the pre-fold receipt left with the rows it followed', shape() === 'user | user', shape())
  const after = crewStillRunningLine({ agents: 2 })!
  conn.addDisplayRow(createSystemMessage(after, 'warning'))
  const a3 = uid()
  appendFileSync(file, line(a3, u3, 7, 'assistant', 'noted'))
  await seam.tick()
  check('K11 a receipt minted after the fold keeps its anchor through a plain append', shape() === `user | user | system:${after} | assistant`, shape())
  const u4 = uid()
  appendFileSync(file, line(u4, a3, 8, 'user', 'again'))
  await seam.tick()
  conn.addDisplayRow(createSystemMessage('late', 'warning'))
  const a3b = uid()
  appendFileSync(file, line(a3b, u3, 9, 'assistant', 'noted differently'))
  await seam.tick()
  check('K11 a partial rewrite keeps the receipt that followed the rows it kept and releases the one past its first moved row', shape() === `user | user | system:${after} | assistant`, shape())
  conn.detach()
  rmSync(home, { recursive: true, force: true })
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} CREW-INTERRUPT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL CREW-INTERRUPT PROOFS PASS')
