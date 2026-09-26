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
const { clearMainChat, enterTeammateView, exitTeammateView, setMainChat, stopOrDismissAgent } = await import('../../src/state/teammateViewHelpers.js')
const { crewmateComposerHint, crewmateHeaderTail, crewmateStatusWords, crewmatePlaceholder, crewmateCardKeys, LEAD_ROW_NAME } = await import('../../src/utils/cockpit/crewmateWords.js')

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
  check('a hosted crewmate takes the connector\'s resumeAgent door and a refusal keeps the draft', /getFocusedSessionConnector\(\)\.resumeAgent\(targetId, text\)/.test(composer) && /if \(!\(await deliver\(intent\.text\)\)\) return/.test(composer))
}

section('§3 the composer\'s target: the pin outlives the view, esc leaves it alone')
{
  const store = makeStore({ a1: agent('a1'), a2: agent('a2') })
  check('nothing viewed, nothing pinned → the lead', composerTargetTaskId(store.state as never) === undefined && !composerTargetPinned(store.state as never))
  enterTeammateView('a1', store.set)
  check('viewing addresses the composer to the viewed crewmate', composerTargetTaskId(store.state as never) === 'a1' && !composerTargetPinned(store.state as never))
  exitTeammateView(store.set)
  check('esc (exit) returns the composer to the lead', composerTargetTaskId(store.state as never) === undefined)
  setMainChat('a2', store.set)
  enterTeammateView('a2', store.set)
  check('m pins the crewmate: target a2, pinned', composerTargetTaskId(store.state as never) === 'a2' && composerTargetPinned(store.state as never))
  enterTeammateView('a1', store.set)
  check('viewing another crewmate does not move a pinned composer', composerTargetTaskId(store.state as never) === 'a2' && store.state.viewingAgentTaskId === 'a1')
  exitTeammateView(store.set)
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

section('§4 the words of the two states (one owner)')
{
  const viewing = { name: 'Lane atlas', pinned: false }
  const pinned = { name: 'Lane fjord', pinned: true }
  check('the header tail: viewing / main chat', crewmateHeaderTail(viewing) === '· Lane atlas · viewing' && crewmateHeaderTail(pinned) === '· Lane fjord · main chat')
  check('the status words', crewmateStatusWords(viewing, 15) === 'viewing Lane atlas · composer → Lane atlas · 15 agents running' && crewmateStatusWords(pinned, 1) === `main chat: Lane fjord · ${LEAD_ROW_NAME} waits in the rail · 1 agent running`)
  check('the composer hint', crewmateComposerHint(viewing) === `↵ sends to Lane atlas · esc back to ${LEAD_ROW_NAME}` && crewmateComposerHint(pinned) === `↵ sends to Lane fjord · m on ${LEAD_ROW_NAME} returns the main chat`)
  check('the placeholder and the card keys', crewmatePlaceholder('Lane fjord') === 'message Lane fjord' && crewmateCardKeys(false).startsWith('m main chat · x stop · p pause · esc back') && crewmateCardKeys(true).startsWith(`m on ${LEAD_ROW_NAME} hands the main chat back`))
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-operator-message-lane: ALL LAWS HOLD' : `\nprove-operator-message-lane: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
