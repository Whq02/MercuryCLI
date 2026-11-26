#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'operator-lane-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

await import('../../src/engine/tasks/tasks.js')
const { drainPendingMessages, peekOperatorMessages, queueOperatorMessage, queuePendingMessage, takeOperatorMessages } = await import('../../src/engine/tasks/local-agent/crewmateTask.js')
const { composerTargetTaskId } = await import('../../src/screen/app-state/selectors.js')
const { clearMainChat, enterCrewmateView, exitCrewmateView, setMainChat, stopOrDismissCrewmate } = await import('../../src/crew/crewmates/crewmateView.js')
const { crewmatePlaceholder } = await import('../../src/screen/cockpit/crewmateWords.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type State = { tasks: Record<string, unknown>; viewingCrewmateTaskId?: string; mainChatTaskId?: string; viewSelectionMode: string }
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
const agent = (id: string, status = 'running'): Record<string, unknown> => ({ id, type: 'local_agent', status, description: `Lane ${id}`, agentId: id, agentType: 'mercury-crew', prompt: '', startTime: Date.now(), isBackgrounded: true, outputFile: '', outputOffset: 0, notified: false })
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
  check('peekOperatorMessages reads without taking', JSON.stringify(peekOperatorMessages(store.state.tasks.a1)) === JSON.stringify(['the operator asks']) && lanes(store, 'a1').operator.length === 1, 'peekOperatorMessages in src/engine/tasks/local-agent/crewmateTask.ts must return the operatorMessages lane without removing it')
  const taken = takeOperatorMessages('a1', store.get, store.set)
  check('takeOperatorMessages hands the lines over and empties the lane', JSON.stringify(taken) === JSON.stringify(['the operator asks']) && lanes(store, 'a1').operator.length === 0, JSON.stringify(taken))
  check('takeOperatorMessages on an empty lane is a no-op', takeOperatorMessages('a1', store.get, store.set).length === 0, 'takeOperatorMessages in src/engine/tasks/local-agent/crewmateTask.ts must return an empty list when operatorMessages is empty')
  check('peekOperatorMessages on a non-agent is empty', peekOperatorMessages(undefined).length === 0 && peekOperatorMessages({ type: 'local_bash' }).length === 0, 'peekOperatorMessages in src/engine/tasks/local-agent/crewmateTask.ts must return an empty list for a task that is not a local agent')
}


section('§3 the composer\'s target: the pin outlives the view, esc leaves it alone')
{
  const store = makeStore({ a1: agent('a1'), a2: agent('a2') })
  check('nothing viewed, nothing pinned → the lead', composerTargetTaskId(store.state as never) === undefined, 'composerTargetTaskId in src/screen/app-state/selectors.ts must report the lead when no crewmate is viewed or pinned')
  enterCrewmateView('a1', store.set)
  check('viewing addresses the composer to the viewed crewmate', composerTargetTaskId(store.state as never) === 'a1', 'composerTargetTaskId in src/screen/app-state/selectors.ts must follow viewingAgentTaskId set by enterCrewmateView in src/crew/crewmates/crewmateView.ts')
  exitCrewmateView(store.set)
  check('esc (exit) returns the composer to the lead', composerTargetTaskId(store.state as never) === undefined)
  setMainChat('a2', store.set)
  enterCrewmateView('a2', store.set)
  check('m pins the crewmate: target a2, pinned', composerTargetTaskId(store.state as never) === 'a2' && store.state.mainChatTaskId === 'a2', 'setMainChat in src/crew/crewmates/crewmateView.ts must set mainChatTaskId and composerTargetTaskId in src/screen/app-state/selectors.ts must report it as the pinned target')
  enterCrewmateView('a1', store.set)
  check('viewing another crewmate does not move a pinned composer', composerTargetTaskId(store.state as never) === 'a2' && store.state.viewingCrewmateTaskId === 'a1', 'composerTargetTaskId in src/screen/app-state/selectors.ts must prefer mainChatTaskId over viewingAgentTaskId')
  exitCrewmateView(store.set)
  check('leaving the view keeps the pin', composerTargetTaskId(store.state as never) === 'a2' && store.state.viewingCrewmateTaskId === undefined, 'exitCrewmateView in src/crew/crewmates/crewmateView.ts must clear viewingAgentTaskId and leave mainChatTaskId alone')
  clearMainChat(store.set)
  check('m on Mercury Lead hands the main chat back', composerTargetTaskId(store.state as never) === undefined && store.state.mainChatTaskId === undefined, 'clearMainChat in src/crew/crewmates/crewmateView.ts must clear mainChatTaskId')
  setMainChat('a1', store.set)
  const before = store.state
  setMainChat('a1', store.set)
  check('pinning the pinned crewmate again is the identity update', store.state === before, 'setMainChat in src/crew/crewmates/crewmateView.ts must return the previous state object when the task is already pinned')
  const taskA1 = store.state.tasks.a1 as { status: string; evictAfter?: number }
  store.state = { ...store.state, tasks: { ...store.state.tasks, a1: { ...taskA1, status: 'completed' } } }
  stopOrDismissCrewmate('a1', store.set)
  check('dismissing the pinned crewmate releases the pin', store.state.mainChatTaskId === undefined, 'stopOrDismissAgent in src/crew/crewmates/crewmateView.ts must clear mainChatTaskId when it dismisses the pinned crewmate')
}

section('§4 the operator\'s interrupt: one crewmate, a typed kind the lead can tell apart')
{
  const { CREWMATE_INTERRUPT_BY_OPERATOR, CREWMATE_INTERRUPTED_STATUS_WORD, CREWMATE_INTERRUPTED_WORDS, CREWMATE_STOP_BY_OPERATOR, crewmateStopReasonOf, crewmateStopStatusWordOf, enqueueCrewmateNotification } = await import('../../src/engine/tasks/local-agent/crewmateTask.js')
  const { turnCutLine, turnCutOf } = await import('../../src/engine/message-shapes/turnCut.js')
  const { interruptCrewmate } = await import('../../src/screen/tasks/crewmateInterrupt.js')
  const { dequeueAll, resetCommandQueue } = await import('../../src/screen/composer/input-core/command-queue.js')
  check('the operator\'s interrupt is a typed cut of the operator\'s own kind — the crewmate\'s transcript row is the lead\'s own interrupt row', turnCutOf(CREWMATE_INTERRUPT_BY_OPERATOR).kind === 'operator' && turnCutLine(turnCutOf(CREWMATE_INTERRUPT_BY_OPERATOR), false) === '[Request interrupted by user]' && turnCutLine(turnCutOf(CREWMATE_INTERRUPT_BY_OPERATOR), true) === '[Request interrupted by user for tool use]', 'turnCutOf and turnCutLine in src/engine/message-shapes/turnCut.ts must treat AGENT_INTERRUPT_BY_OPERATOR as the operator kind and print the two interrupt rows')
  check('the stop words and the status word name the operator, distinct from the crew view\'s stop', crewmateStopReasonOf(CREWMATE_INTERRUPT_BY_OPERATOR) === CREWMATE_INTERRUPTED_WORDS && crewmateStopStatusWordOf(CREWMATE_INTERRUPT_BY_OPERATOR) === CREWMATE_INTERRUPTED_STATUS_WORD && crewmateStopReasonOf(CREWMATE_STOP_BY_OPERATOR) === 'stopped from the crew view' && crewmateStopStatusWordOf(CREWMATE_STOP_BY_OPERATOR) === undefined && crewmateStopStatusWordOf('stalled') === undefined, 'agentStopReasonOf and agentStopStatusWordOf in src/engine/tasks/local-agent/crewmateTask.ts must map the operator interrupt to the interrupted words and status word, and the crew view stop to its own words with no status word')
  const notices = (reason: string): string => {
    resetCommandQueue()
    const store = makeStore({ n1: agent('n1', 'killed') })
    enqueueCrewmateNotification({ taskId: 'n1', description: 'Lane n1', status: 'killed', setAppState: store.set, stopReason: crewmateStopReasonOf(reason), statusWord: crewmateStopStatusWordOf(reason) })
    const queued = dequeueAll()
    return queued.map(command => (typeof command.value === 'string' ? command.value : '')).join('\n')
  }
  const interrupted = notices(CREWMATE_INTERRUPT_BY_OPERATOR)
  const stopped = notices(CREWMATE_STOP_BY_OPERATOR)
  console.log(`  the lead's notice for an interrupted crewmate:\n${interrupted.split('\n').map(line => `    ${line}`).join('\n')}`)
  check('the lead\'s notice carries the typed kind <status>interrupted</status> and says the operator cut it off', interrupted.includes(`<status>${CREWMATE_INTERRUPTED_STATUS_WORD}</status>`) && interrupted.includes(CREWMATE_INTERRUPTED_WORDS) && interrupted.includes('the operator cut it off on purpose — not a fault, not a loop stop'), interrupted.slice(0, 300))
  check('a crewmate stopped from the crew view carries the plain killed status and never the interrupted kind', stopped.includes('<status>killed</status>') && stopped.includes('stopped from the crew view') && !stopped.includes(`<status>${CREWMATE_INTERRUPTED_STATUS_WORD}</status>`) && !stopped.includes(CREWMATE_INTERRUPTED_WORDS), stopped.slice(0, 300))
  resetCommandQueue()
  const a = new AbortController()
  const b = new AbortController()
  const store = makeStore({ a1: { ...agent('a1'), abortController: a }, a2: { ...agent('a2'), abortController: b } })
  const stops: Array<{ id: string; note?: string }> = []
  const road = interruptCrewmate('a1', store.state as never, store.set, async (id, note) => { stops.push({ id, note }) })
  check('a local crewmate\'s interrupt aborts ITS controller with the typed reason and leaves the other crewmate running', road === 'local' && a.signal.aborted && a.signal.reason === CREWMATE_INTERRUPT_BY_OPERATOR && !b.signal.aborted && stops.length === 0, `interruptCrewmate in src/screen/tasks/crewmateInterrupt.ts must abort only the named local crewmate with AGENT_INTERRUPT_BY_OPERATOR; road was ${road}`)
  const hosted = interruptCrewmate('h9', store.state as never, store.set, async (id, note) => { stops.push({ id, note }) })
  check('a hosted crewmate\'s interrupt takes the connector\'s stop door with the typed note, once, for that id alone', hosted === 'hosted' && JSON.stringify(stops) === JSON.stringify([{ id: 'h9', note: CREWMATE_INTERRUPT_BY_OPERATOR }]), `interruptCrewmate in src/screen/tasks/crewmateInterrupt.ts must call the stop door once with the typed note for an id with no local task; got ${hosted} and ${JSON.stringify(stops)}`)
  const idle = interruptCrewmate('a2', { tasks: { a2: agent('a2', 'completed') } } as never, store.set, async () => {})
  check('a crewmate between turns has nothing to interrupt', idle === 'idle', `interruptCrewmate in src/screen/tasks/crewmateInterrupt.ts must return idle for a task that is not running; got ${idle}`)
}

check('a distinct pinned recipient is named in the placeholder', crewmatePlaceholder('Lane fjord') === 'message Lane fjord', 'check crewmatePlaceholder in src/screen/cockpit/crewmateWords.ts')

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-operator-message-lane: ALL LAWS HOLD' : `\nprove-operator-message-lane: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
