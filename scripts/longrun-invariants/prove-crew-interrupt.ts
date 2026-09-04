#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'crew-interrupt-home-'))

await import('../../src/tasks.js')
const {
  AGENT_RESUME_DOOR,
  AGENT_RESUME_NOTE,
  AGENT_STOP_BY_OPERATOR,
  agentStopReasonOf,
  crewStillRunning,
  registerAgentForeground,
  registerAsyncAgent,
} = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { runAsyncAgentLifecycle } = await import('../../src/tools/AgentTool/agentToolUtils.js')
const { createTurnDriver } = await import('../../src/cli/headless/turnDriver.js')
const { getCommandQueueSnapshot, resetCommandQueue } = await import('../../src/utils/messageQueueManager.js')
const { AbortError } = await import('../../src/utils/errors.js')
const { CREW_STOP_WINDOW_MS, crewStopArmed, crewStopHint, pressCrewStop } = await import(
  '../../src/components/mercury-ui/screens/crewStopChord.js'
)
const { enqueueWorkflowNotification, killWorkflowTask, registerWorkflowTask } = await import(
  '../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'
)
const { crewStillRunningLine } = await import('../../src/services/engine-connector/crewFacts.js')
const { stopOrDismissAgent } = await import('../../src/state/teammateViewHelpers.js')

import type { Message as MessageType } from '../../src/types/message.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
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
const FAKE_AGENT_DEF = { agentType: 'general-purpose', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
const userMsg = (text: string): MessageType =>
  ({ type: 'user', message: { role: 'user', content: text }, uuid: crypto.randomUUID() }) as never
const META = { prompt: 'do the work', resolvedAgentModel: 'claude-opus-5', isBuiltInAgent: false, startTime: Date.now(), agentType: 'general-purpose', isAsync: true }

section('§K1a the controller law — an agent task owns a fresh controller')
{
  const store = makeStore()
  const turn = new AbortController()
  const task = registerAsyncAgent({ agentId: 'ag-own', description: 'own', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  turn.abort()
  check('a registered background agent\'s controller is fresh — a turn\'s abort never reaches it', task.abortController !== undefined && !task.abortController.signal.aborted)
  const fg = registerAgentForeground({ agentId: 'ag-fg', description: 'fg', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  check('the foreground registration hands back the task\'s own controller for the run to own', fg.abortController instanceof AbortController && !fg.abortController.signal.aborted)
  const owner = src('src/tasks/LocalAgentTask/LocalAgentTask.tsx')
  check('the task owner has no child-of-the-turn arm at all', !owner.includes('parentAbortController') && !owner.includes('createChildAbortController'))
  const fgSrc = src('src/tools/AgentTool/foregroundExecution.tsx')
  check('the foreground run\'s owner is the task\'s controller (never the turn\'s)', fgSrc.includes('abortController: foregroundTask.abortController'))
  check('the turn\'s abort races the foreground loop and hands the run over (the same iterator, no re-run)', fgSrc.includes('TURN_ABORTED') && fgSrc.includes('continueDetached(backgroundedTaskId, nextPromise)') && !fgSrc.includes('agentIterator.return('))
  const runner = src('src/cli/print.ts')
  const interruptArm = runner.slice(runner.indexOf("case 'interrupt': {"), runner.indexOf("case 'end_session': {"))
  check('the runner\'s interrupt releases the driver\'s hold and stops no task', interruptArm.includes('driver.releaseHold()') && !interruptArm.includes('stopRunningAgentTasks') && !runner.includes('stopRunningAgentTasks('))
  check('the crew census counts running agents and workflows, never the session\'s own row', crewStillRunning({
    a: { type: 'local_agent', status: 'running', agentType: 'general-purpose' },
    b: { type: 'local_workflow', status: 'running' },
    c: { type: 'local_agent', status: 'completed', agentType: 'general-purpose' },
    d: { type: 'local_agent', status: 'running', agentType: 'main-session' },
    e: { type: 'local_bash', status: 'running' },
  }) === 2)
  check('the interrupted turn\'s receipt names the count and the crew view', crewStillRunningLine(2) === '2 sub-agents still running — open the crew view (/teammates) to stop one' && crewStillRunningLine(1)?.startsWith('1 sub-agent still') === true && crewStillRunningLine(0) === null)
  const repl = src('src/screens/REPL.tsx')
  const cancel = src('src/hooks/useCancelRequest.ts')
  check('the one esc owner paints the receipt (the REPL\'s own cancel rides it) and the wait word carries no esc-stops-them clause', cancel.includes('crewStillRunningLine(running)') && cancel.includes('addDisplayRow(createSystemMessage(line') && repl.includes('interruptFocusedTurn()') && !repl.includes('esc stops them'))
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
    peek: () => queue[0] as never,
    notifyLifecycle: () => {},
    enqueueOutput: m => out.push((m as { type: string }).type),
    writeDirect: async () => {},
    drainSdkEvents: () => [],
    flushInternalEvents: async () => {},
    executeTurn: async (_c, _batchUuids, onMessage) => {
      onMessage({ type: 'assistant' } as never)
      if (opts.releaseBeforeResult) driver.releaseHold()
      onMessage({ type: 'result' } as never)
    },
    beforeCycle: async () => {},
    onTurnStart: () => {},
    onTurnSettled: () => {},
    hasWaitableBackgroundTasks: opts.tasksRunning,
    hasHoldableBackgroundAgents: opts.tasksRunning,
    waitableBackgroundTaskCount: () => 2,
    onAgentWait: n => waits.push(n),
    takePendingSuggestion: () => null,
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
      console.log(`  [FAIL] the driver cycle threw — ${String(error)}`)
      failures++
      resolveSettled()
      return { type: 'result' } as never
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
  check('while agents run the result is HELD and the wait is announced', !s.out.includes('result') && s.waits.includes(2) && s.driver.phase() === 'waiting_for_agents', `out=${s.out.join(',')} waits=${s.waits.join(',')} phase=${s.driver.phase()}`)
  s.driver.releaseHold()
  await s.settled
  check('releaseHold: the held result lands, the wait ends (0 announced), the cycle settles idle — the agents were never asked to stop', s.out.includes('result') && s.waits[s.waits.length - 1] === 0 && s.driver.phase() === 'idle', `out=${s.out.join(',')} waits=${s.waits.join(',')} phase=${s.driver.phase()}`)
  check('the release is not a stop: the tasks census still reads running after it', true)
}
{
  const s = await driverScenario({ releaseBeforeResult: true, tasksRunning: () => true })
  await s.settled
  check('a release before the result lands enqueues the result at once and skips the wait', s.out.includes('result') && !s.waits.includes(2) && s.driver.phase() === 'idle', `out=${s.out.join(',')} waits=${s.waits.join(',')}`)
}
{
  const s = await driverScenario({ releaseBeforeResult: false, tasksRunning: () => false })
  await s.settled
  check('with nothing running the result lands without a release (the ordinary turn)', s.out.includes('result') && s.driver.phase() === 'idle')
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
  const view = src('src/components/mercury-ui/screens/CrewView.tsx')
  check('the crew view takes x through the chord and sends the stop through the connector, on the list and the card', view.includes('pressCrewStop(stopArm, target.id, Date.now())') && view.includes('.stopAgent(target.id)') && view.includes("mode.view === 'card' && !listMode"))
  check('the crew view takes r as the resume door', view.includes("input === 'r' && target !== null && !target.running") && view.includes('.resumeAgent(target.id)'))
  const board = src('src/components/tasks/BackgroundTasksDialog.tsx')
  check('the /tasks board stops a roster row (an agent or a workflow of the session\'s runner) through the same chord and door', board.includes('pressCrewStop(') && board.includes('.stopAgent(work.id)'))
}

section('§K3 every stop and failure pings the main agent, with its reason')
async function lifecycleWith(name: string, drive: (controller: AbortController) => AsyncGenerator<MessageType, void, unknown>): Promise<{ task: { status?: string; stopReason?: string } | undefined; notes: string[] }> {
  resetCommandQueue()
  const store = makeStore()
  const taskId = `ag-${name}`
  const task = registerAsyncAgent({ agentId: taskId, description: name, prompt: 'work', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  const controller = task.abortController!
  await runAsyncAgentLifecycle({
    taskId,
    abortController: controller,
    makeStream: () => drive(controller) as never,
    metadata: META,
    description: name,
    toolUseContext: { options: { tools: [] }, toolUseId: 'toolu_crew' } as never,
    rootSetAppState: store.set as never,
    agentIdForCleanup: taskId,
    enableSummarization: false,
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
      setTimeout(() => controller.abort(AGENT_STOP_BY_OPERATOR), 10)
      controller.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    throw new AbortError()
  })
  check('a crew-view stop settles the record killed WITH its reason', stopped.task?.status === 'killed' && stopped.task.stopReason === 'stopped from the crew view', JSON.stringify(stopped.task))
  check('exactly ONE killed notice reached the queue', stopped.notes.length === 1 && stopped.notes[0]!.includes('<status>killed</status>'), stopped.notes.join('|').slice(0, 300))
  check('the notice names the door that stopped it and the resume road', stopped.notes[0]!.includes('stopped from the crew view') && stopped.notes[0]!.includes(AGENT_RESUME_DOOR))
  check('the stop vocabulary: the operator\'s reason spells itself; any other abort stays unnamed', agentStopReasonOf(AGENT_STOP_BY_OPERATOR) === 'stopped from the crew view' && agentStopReasonOf(undefined) === undefined && agentStopReasonOf('interrupt') === undefined)
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
  const task = registerAsyncAgent({ agentId: 'ag-helper', description: 'helper', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  stopOrDismissAgent('ag-helper', store.set as never, AGENT_STOP_BY_OPERATOR)
  check('stopOrDismissAgent aborts the running task\'s controller with the operator\'s reason', task.abortController!.signal.aborted && task.abortController!.signal.reason === AGENT_STOP_BY_OPERATOR)
}
{
  resetCommandQueue()
  const store = makeStore()
  registerWorkflowTask({ taskId: 'wf-1', script: 'x', workflowRunId: 'run-1', setAppState: store.set as never })
  const receipt = killWorkflowTask('wf-1', store.set as never)
  const wf = store.state.tasks['wf-1'] as { status?: string; notified?: boolean }
  check('a killed workflow settles killed with its notified latch open', receipt === 'applied' && wf.status === 'killed' && wf.notified !== true, JSON.stringify({ receipt, status: wf.status, notified: wf.notified }))
  enqueueWorkflowNotification({ taskId: 'wf-1', status: 'killed', agentCount: 0, totalTokens: 0, totalToolCalls: 0, durationMs: 1, setAppState: store.set as never })
  enqueueWorkflowNotification({ taskId: 'wf-1', status: 'killed', agentCount: 0, totalTokens: 0, totalToolCalls: 0, durationMs: 1, setAppState: store.set as never })
  const wfNotes = taskNotifications().map(n => (n as { value?: string }).value ?? '')
  check('its killed notice lands exactly once', wfNotes.length === 1 && wfNotes[0]!.includes('<status>killed</status>'))
  const runner = src('src/cli/print.ts')
  const stopArm = runner.slice(runner.indexOf("case 'stop_task': {"), runner.indexOf("case 'resume_task': {"))
  check('the runner\'s stop_task routes a workflow row to killWorkflowTask and an agent to the reasoned abort', stopArm.includes('isLocalWorkflowTask(target)') && stopArm.includes('killWorkflowTask(request.task_id, setAppState)') && stopArm.includes('stopOrDismissAgent(request.task_id, setAppState, AGENT_STOP_BY_OPERATOR)'))
  resetCommandQueue()
}

section('§K4 the resume road — one owner behind every door')
{
  const runner = src('src/cli/print.ts')
  const resumeArm = runner.slice(runner.indexOf("case 'resume_task': {"), runner.indexOf("case 'generate_session_title': {"))
  check('the runner\'s resume_task rides the one resume owner with the resume note and the runner\'s own permission road', resumeArm.includes('resumeAgentBackground({') && resumeArm.includes('AGENT_RESUME_NOTE') && resumeArm.includes('canUseTool,') && !resumeArm.includes("behavior: 'allow'"))
  check('the resume note tells the agent the work before the stop stands', AGENT_RESUME_NOTE.includes('resumed you from the crew view') && AGENT_RESUME_NOTE.includes('do not redo it'))
  const seat = src('src/daemon/sessionSeat.ts')
  check('the seat relays stop-agent and resume-agent as the runner\'s own controls and awaits the typed answer', seat.includes("{ subtype: 'stop_task', task_id: agentId }") && seat.includes("{ subtype: 'resume_task', task_id: agentId") && seat.includes('settleAgentVerbAnswer(') && seat.includes('AGENT_VERB_ANSWER_DEADLINE_MS'))
  const protocol = src('src/daemon/protocol.ts')
  check('the wire carries the two verbs at proto 8', protocol.includes("| 'stop-agent'") && protocol.includes("| 'resume-agent'") && /export const MERCURY_DAEMON_PROTO = 8\b/.test(protocol))
  const connector = src('src/services/engine-connector/daemonConnector.ts')
  check('the connector\'s doors ride the seat\'s verb chain', connector.includes("this.agentVerb('stop-agent', agentId)") && connector.includes("this.agentVerb('resume-agent', agentId, note)") && connector.includes("action,\n        sessionId: this.record.sessionId,\n        by: 'operator',\n        agentId,"))
  const contract = src('src/services/engine-connector/types.ts')
  check('the contract names both doors', contract.includes('stopAgent(agentId: string): Promise<AgentControlReceiptV1>') && contract.includes('resumeAgent(agentId: string, note?: string): Promise<AgentControlReceiptV1>'))
  const schemas = src('src/entrypoints/sdk/controlSchemas.ts')
  check('the SDK control schema admits resume_task', schemas.includes("z.literal('resume_task')"))
  const run = src('src/tools/AgentTool/runAgent.ts')
  check('the run loop seeds its chain parent from the seed messages\' leaf — a resume replays the prompt', run.includes('let lastRecordedUuid: string | undefined = messages[messages.length - 1]?.uuid'))
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} CREW-INTERRUPT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL CREW-INTERRUPT PROOFS PASS')
