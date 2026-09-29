#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'operator-lane-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

await import('../../src/tasks.js')
const { drainPendingMessages, peekOperatorMessages, queueOperatorMessage, queuePendingMessage, takeOperatorMessages } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { composerTargetTaskId, composerTargetPinned } = await import('../../src/state/selectors.js')
const { clearMainChat, enterCrewmateView, exitCrewmateView, setMainChat, stopOrDismissAgent } = await import('../../src/state/crewmateViewHelpers.js')
const { crewmateComposerHint, crewmateHeaderTail, crewmateStatusWords, crewmatePlaceholder, crewmateCardKeys, BACK_HINT, LEAD_ROW_NAME } = await import('../../src/utils/cockpit/crewmateWords.js')

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type State = { tasks: Record<string, unknown>; viewingAgentTaskId?: string; mainChatTaskId?: string; viewSelectionMode: string }
function makeStore(tasks: Record<string, unknown>): { state: State; set: (fn: (prev: never) => never) => void; get: () => never } {
  const store = {
    state: { tasks, viewSelectionMode: 'none' } as State,
    set(fn: (prev: never) => never) {
      store.state = (fn as (p: unknown) => State)(store.state)
    },
    get: () => store.state as never,
  }
  return store
}
const agent = (id: string, status = 'running'): Record<string, unknown> => ({ id, type: 'local_agent', status, description: `Lane ${id}`, agentId: id, agentType: 'mercury-general', prompt: '', startTime: Date.now(), isBackgrounded: true, outputFile: '', outputOffset: 0, notified: false })
const lanes = (store: ReturnType<typeof makeStore>, id: string): { pending: string[]; operator: string[] } => {
  const task = store.state.tasks[id] as { pendingMessages?: string[]; operatorMessages?: string[] }
  return { pending: task.pendingMessages ?? [], operator: task.operatorMessages ?? [] }
}

section('§1 the operator lane is its own queue: the tool-boundary drain never takes it')
{
  const store = makeStore({ a1: agent('a1') })
  queuePendingMessage('a1', 'the lead steers', store.set)
  queueOperatorMessage('a1', 'the operator asks', store.set)
  check('queueOperatorMessage lands in operatorMessages, never in pendingMessages', JSON.stringify(lanes(store, 'a1')) === JSON.stringify({ pending: ['the lead steers'], operator: ['the operator asks'] }), JSON.stringify(lanes(store, 'a1')))
  const drained = drainPendingMessages('a1', store.get, store.set)
  check('the tool-boundary drain takes the lead\'s lane only', JSON.stringify(drained) === JSON.stringify(['the lead steers']), JSON.stringify(drained))
  check('the operator lane survives the tool-boundary drain', JSON.stringify(lanes(store, 'a1')) === JSON.stringify({ pending: [], operator: ['the operator asks'] }), JSON.stringify(lanes(store, 'a1')))
  check('peekOperatorMessages reads without taking', JSON.stringify(peekOperatorMessages(store.state.tasks.a1)) === JSON.stringify(['the operator asks']) && lanes(store, 'a1').operator.length === 1)
  const taken = takeOperatorMessages('a1', store.get, store.set)
  check('takeOperatorMessages hands the lines over and empties the lane', JSON.stringify(taken) === JSON.stringify(['the operator asks']) && lanes(store, 'a1').operator.length === 0, JSON.stringify(taken))
  check('takeOperatorMessages on an empty lane is a no-op', takeOperatorMessages('a1', store.get, store.set).length === 0)
  check('peekOperatorMessages on a non-agent is empty', peekOperatorMessages(undefined).length === 0 && peekOperatorMessages({ type: 'local_bash' }).length === 0)
}

section('§2 the turn-end and stop roads deliver the lane; the running resume queues it (source pins)')
{
  const lifecycle = readFileSync(join(ROOT, 'src/tools/AgentTool/agentToolUtils.ts'), 'utf8')
  check('the completion drain reads both lanes and resumes with them', /\[\.\.\.\(task\.pendingMessages \?\? \[\]\), \.\.\.peekOperatorMessages\(task\)\]/.test(lifecycle) && /takeOperatorMessages\(taskId, stateReader, rootSetAppState\)/.test(lifecycle))
  check('the operator\'s stop (the abort road) delivers the lane after the kill notice', /killAsyncAgent\(taskId, rootSetAppState, stopReason, args\.abortController\)[\s\S]*deliverOperatorMessagesAfterStop\(taskId, description, toolUseContext, rootSetAppState, args\.canUseTool\)/.test(lifecycle))
  check('the stop-road delivery resumes with a fresh controller and only then takes the lane', /abortController: new AbortController\(\)[\s\S]*takeOperatorMessages\(taskId, stateReader, rootSetAppState\)/.test(lifecycle))
  const queued = readFileSync(join(ROOT, 'src/utils/attachments/queuedCommands.ts'), 'utf8')
  check('the tool-boundary attachment drain still reads drainPendingMessages alone (never the operator lane)', /drainPendingMessages\(/.test(queued) && !/OperatorMessages/.test(queued))
  const runner = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')
  check('the runner\'s resume_task queues a note for a RUNNING agent into the operator lane and answers queued', /target\.status === 'running'[\s\S]{0,400}queueOperatorMessage\(request\.task_id, note, setAppState\)[\s\S]{0,120}respondSuccess\(requestId, \{ queued: true, agent_id: request\.task_id \}\)/.test(runner))
  check('a running agent with no note still answers the old refusal', /note === '' \|\| !isLocalAgentTask\(target\)[\s\S]{0,80}the agent is running — nothing to resume/.test(runner))
  const composer = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  check('the composer\'s send road targets composerTargetTaskId and queues a local crewmate on the operator lane', /const targetId = composerTargetTaskId\(fresh\)/.test(composer) && /queueOperatorMessage\(task\.id, text, setAppState\)/.test(composer) && !/queuePendingMessage\(/.test(composer))
  check('a hosted crewmate takes the connector\'s resumeAgent door; the line is taken when ↵ lands and a refusal hands it back', /getFocusedSessionConnector\(\)\.resumeAgent\(targetId, text\)/.test(composer) && /takeLine\(\)\s*\n\s*if \(!\(await deliver\([^)]*\)\)\) handBack\(\)/.test(composer))
}

section('§3 the composer\'s target: the pin outlives the view, esc leaves it alone')
{
  const store = makeStore({ a1: agent('a1'), a2: agent('a2') })
  check('nothing viewed, nothing pinned → the lead', composerTargetTaskId(store.state as never) === undefined && !composerTargetPinned(store.state as never))
  enterCrewmateView('a1', store.set)
  check('viewing addresses the composer to the viewed crewmate', composerTargetTaskId(store.state as never) === 'a1' && !composerTargetPinned(store.state as never))
  exitCrewmateView(store.set)
  check('esc (exit) returns the composer to the lead', composerTargetTaskId(store.state as never) === undefined)
  setMainChat('a2', store.set)
  enterCrewmateView('a2', store.set)
  check('m pins the crewmate: target a2, pinned', composerTargetTaskId(store.state as never) === 'a2' && composerTargetPinned(store.state as never))
  enterCrewmateView('a1', store.set)
  check('viewing another crewmate does not move a pinned composer', composerTargetTaskId(store.state as never) === 'a2' && store.state.viewingAgentTaskId === 'a1')
  exitCrewmateView(store.set)
  check('leaving the view keeps the pin', composerTargetTaskId(store.state as never) === 'a2' && store.state.viewingAgentTaskId === undefined)
  clearMainChat(store.set)
  check('m on Mercury Lead hands the main chat back', composerTargetTaskId(store.state as never) === undefined && store.state.mainChatTaskId === undefined)
  setMainChat('a1', store.set)
  const before = store.state
  setMainChat('a1', store.set)
  check('pinning the pinned crewmate again is the identity update', store.state === before)
  const taskA1 = store.state.tasks.a1 as { status: string; evictAfter?: number }
  store.state = { ...store.state, tasks: { ...store.state.tasks, a1: { ...taskA1, status: 'completed' } } }
  stopOrDismissAgent('a1', store.set)
  check('dismissing the pinned crewmate releases the pin', store.state.mainChatTaskId === undefined)
}

section('§4 the operator\'s interrupt: one crewmate, a typed kind the lead can tell apart')
{
  const { AGENT_INTERRUPT_BY_OPERATOR, AGENT_INTERRUPTED_STATUS_WORD, AGENT_INTERRUPTED_WORDS, AGENT_STOP_BY_OPERATOR, agentStopReasonOf, agentStopStatusWordOf, enqueueAgentNotification } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
  const { turnCutLine, turnCutOf } = await import('../../src/utils/messages/turnCut.js')
  const { interruptCrewmate } = await import('../../src/components/tasks/crewmateInterrupt.js')
  const { dequeueAll, resetCommandQueue } = await import('../../src/input-core/command-queue.js')
  check('the operator\'s interrupt is a typed cut of the operator\'s own kind — the crewmate\'s transcript row is the lead\'s own interrupt row', turnCutOf(AGENT_INTERRUPT_BY_OPERATOR).kind === 'operator' && turnCutLine(turnCutOf(AGENT_INTERRUPT_BY_OPERATOR), false) === '[Request interrupted by user]' && turnCutLine(turnCutOf(AGENT_INTERRUPT_BY_OPERATOR), true) === '[Request interrupted by user for tool use]')
  check('the stop words and the status word name the operator, distinct from the crew view\'s stop', agentStopReasonOf(AGENT_INTERRUPT_BY_OPERATOR) === AGENT_INTERRUPTED_WORDS && agentStopStatusWordOf(AGENT_INTERRUPT_BY_OPERATOR) === AGENT_INTERRUPTED_STATUS_WORD && agentStopReasonOf(AGENT_STOP_BY_OPERATOR) === 'stopped from the crew view' && agentStopStatusWordOf(AGENT_STOP_BY_OPERATOR) === undefined && agentStopStatusWordOf('stalled') === undefined)
  const notices = (reason: string): string => {
    resetCommandQueue()
    const store = makeStore({ n1: agent('n1', 'killed') })
    enqueueAgentNotification({ taskId: 'n1', description: 'Lane n1', status: 'killed', setAppState: store.set, stopReason: agentStopReasonOf(reason), statusWord: agentStopStatusWordOf(reason) })
    const queued = dequeueAll()
    return queued.map(command => (typeof command.value === 'string' ? command.value : '')).join('\n')
  }
  const interrupted = notices(AGENT_INTERRUPT_BY_OPERATOR)
  const stopped = notices(AGENT_STOP_BY_OPERATOR)
  console.log(`  the lead's notice for an interrupted crewmate:\n${interrupted.split('\n').map(line => `    ${line}`).join('\n')}`)
  check('the lead\'s notice carries the typed kind <status>interrupted</status> and says the operator cut it off', interrupted.includes(`<status>${AGENT_INTERRUPTED_STATUS_WORD}</status>`) && interrupted.includes(AGENT_INTERRUPTED_WORDS) && interrupted.includes('the operator cut it off on purpose — not a fault, not a loop stop'), interrupted.slice(0, 300))
  check('a crewmate stopped from the crew view carries the plain killed status and never the interrupted kind', stopped.includes('<status>killed</status>') && stopped.includes('stopped from the crew view') && !stopped.includes(`<status>${AGENT_INTERRUPTED_STATUS_WORD}</status>`) && !stopped.includes(AGENT_INTERRUPTED_WORDS), stopped.slice(0, 300))
  resetCommandQueue()
  const a = new AbortController()
  const b = new AbortController()
  const store = makeStore({ a1: { ...agent('a1'), abortController: a }, a2: { ...agent('a2'), abortController: b } })
  const stops: Array<{ id: string; note?: string }> = []
  const road = interruptCrewmate('a1', store.state as never, store.set, async (id, note) => { stops.push({ id, note }) })
  check('a local crewmate\'s interrupt aborts ITS controller with the typed reason and leaves the other crewmate running', road === 'local' && a.signal.aborted && a.signal.reason === AGENT_INTERRUPT_BY_OPERATOR && !b.signal.aborted && stops.length === 0)
  const hosted = interruptCrewmate('h9', store.state as never, store.set, async (id, note) => { stops.push({ id, note }) })
  check('a hosted crewmate\'s interrupt takes the connector\'s stop door with the typed note, once, for that id alone', hosted === 'hosted' && JSON.stringify(stops) === JSON.stringify([{ id: 'h9', note: AGENT_INTERRUPT_BY_OPERATOR }]))
  const idle = interruptCrewmate('a2', { tasks: { a2: agent('a2', 'completed') } } as never, store.set, async () => {})
  check('a crewmate between turns has nothing to interrupt', idle === 'idle')
  const seat = readFileSync(join(ROOT, 'src/daemon/sessionSeat.ts'), 'utf8')
  const runner = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')
  const connector = readFileSync(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  const lifecycle = readFileSync(join(ROOT, 'src/tools/AgentTool/agentToolUtils.ts'), 'utf8')
  const cancel = readFileSync(join(ROOT, 'src/hooks/useCancelRequest.ts'), 'utf8')
  check('the typed note rides the stop verb across the wire: connector → seat (stop_task note) → runner (the operator-interrupt reason)', /stopAgent\(agentId: string, note\?: string\)[\s\S]{0,80}agentVerb\('stop-agent', agentId, note\)/.test(connector) && /subtype: 'stop_task', task_id: agentId, \.\.\.\(opts\?\.note !== undefined \? \{ note: opts\.note \} : \{\}\)/.test(seat) && /request\.note === AGENT_INTERRUPT_BY_OPERATOR \? \{ reason: AGENT_INTERRUPT_BY_OPERATOR \} : \{\}/.test(runner))
  check('the lifecycle\'s abort road stamps the notice with the typed status word', /const stopStatusWord = agentStopStatusWordOf\(args\.abortController\.signal\.reason\)/.test(lifecycle) && /\.\.\.\(stopStatusWord !== undefined \? \{ statusWord: stopStatusWord \} : \{\}\)/.test(lifecycle))
  check('ctrl+c on a crewmate\'s screen interrupts that crewmate alone and never the lead\'s turn (the old kill-all road is gone from the viewing branch)', /interruptCrewmate\(viewedCrewmate, freshState, setAppState\)\s*\n\s*return/.test(cancel) && !/killRunningAgents\(\(\) => store\.getState\(\) as AppState, setAppState\)\s*\n\s*if \(killed\) onAgentsKilled\?\.\(\)\s*\n\s*setAppState\(prev => \(\{\s*\n\s*\.\.\.prev,\s*\n\s*viewingAgentTaskId: undefined/.test(cancel))
}

section('§5 the words of the two states (one owner)')
{
  const viewing = { name: 'Lane atlas', pinned: false }
  const pinned = { name: 'Lane fjord', pinned: true }
  check('the header tail: viewing / main chat', crewmateHeaderTail(viewing) === '· Lane atlas · viewing' && crewmateHeaderTail(pinned) === '· Lane fjord · main chat')
  check('the status words: the viewed crewmate, the composer\'s target, and the pin viewed from another screen', crewmateStatusWords(viewing, viewing, 15) === 'viewing Lane atlas · composer → Lane atlas · 15 agents running' && crewmateStatusWords(pinned, pinned, 1) === `main chat: Lane fjord · ${LEAD_ROW_NAME} waits in the rail · 1 agent running` && crewmateStatusWords(null, pinned, 1) === `main chat: Lane fjord · ${LEAD_ROW_NAME} waits in the rail · 1 agent running` && crewmateStatusWords(viewing, pinned, 2) === 'viewing Lane atlas · composer → Lane fjord (the main chat) · 2 agents running')
  check('the composer hint: ↵ names the target, esc names the VIEWED crewmate (none on the lead\'s screen); the way back is the rail', crewmateComposerHint(viewing, viewing) === `↵ sends to Lane atlas · esc interrupts Lane atlas · ${BACK_HINT}` && crewmateComposerHint(pinned, pinned) === `↵ sends to Lane fjord · esc interrupts Lane fjord · m on ${LEAD_ROW_NAME} returns the main chat` && crewmateComposerHint(pinned, viewing) === `↵ sends to Lane fjord · esc interrupts Lane atlas · m on ${LEAD_ROW_NAME} returns the main chat` && crewmateComposerHint(pinned, null) === `↵ sends to Lane fjord · m on ${LEAD_ROW_NAME} returns the main chat`)
  check('the placeholder and the card keys', crewmatePlaceholder('Lane fjord') === 'message Lane fjord' && crewmateCardKeys(false) === `esc interrupts · m main chat · x stop · p pause · ${BACK_HINT}` && crewmateCardKeys(true).startsWith(`esc interrupts · m on ${LEAD_ROW_NAME} hands the main chat back`))
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-operator-message-lane: ALL LAWS HOLD' : `\nprove-operator-message-lane: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
