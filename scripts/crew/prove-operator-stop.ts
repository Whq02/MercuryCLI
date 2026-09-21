#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'operator-stop-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

await import('../../src/tasks.js')
const { AGENT_STOP_SETTLE_MS, notRunningWords, stopAgentByOperator, unsettledWords } = await import('../../src/services/agents/operatorStop.js')
const { AGENT_STOP_BY_OPERATOR, registerAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { AGENT_VERB_ANSWER_DEADLINE_MS } = await import('../../src/daemon/sessionSeat.js')
const { registerWorkflowTask } = await import('../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js')
const { spawnInProcessTeammate } = await import('../../src/utils/swarm/spawnInProcess.js')
const { resolveStopTargetId } = await import('../../src/tasks/stopTask.js')
const { bareMissWords } = await import('../../src/tasks/stopTask.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type State = { tasks: Record<string, unknown>; speculation: { status: string }; agentNameRegistry: Map<string, string>; teamContext?: unknown }
function makeStore(): { state: State; set: (fn: (prev: never) => never) => void; get: () => never } {
  const store = {
    state: { tasks: {}, speculation: { status: 'idle' }, agentNameRegistry: new Map<string, string>() } as State,
    set(fn: (prev: never) => never) {
      store.state = (fn as (p: unknown) => State)(store.state)
    },
    get: () => store.state as never,
  }
  return store
}
const FAKE_AGENT_DEF = { agentType: 'mercury-general', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
const statusOf = (store: ReturnType<typeof makeStore>, id: string): string | undefined => (store.state.tasks[id] as { status?: string } | undefined)?.status
const quick = { settleMs: 300, sleep: (ms: number) => new Promise<void>(r => setTimeout(r, Math.min(ms, 10))) }

section('the budget: the runner settles a stop well inside the seat\'s answer deadline')
check('the settle budget is a fraction of the seat\'s deadline for the answer', AGENT_STOP_SETTLE_MS > 0 && AGENT_STOP_SETTLE_MS * 2 <= AGENT_VERB_ANSWER_DEADLINE_MS, `${AGENT_STOP_SETTLE_MS} vs ${AGENT_VERB_ANSWER_DEADLINE_MS}`)

section('a named teammate: the operator\'s stop kills it and answers applied; a second stop is refused with its status')
{
  const store = makeStore()
  const spawned = await spawnInProcessTeammate({ name: 'sonnet-ping', teamName: 'ping-team', prompt: 'reply ping', planModeRequired: false }, { setAppState: store.set as never })
  check('the teammate registers running', spawned.success && spawned.taskId !== undefined && statusOf(store, spawned.taskId) === 'running', JSON.stringify(spawned))
  const id = spawned.taskId!
  const receipt = await stopAgentByOperator(id, { getAppState: store.get, setAppState: store.set as never }, quick)
  check('the stop is applied as a teammate kill', receipt.outcome === 'applied' && receipt.kind === 'teammate' && receipt.status === 'killed', JSON.stringify(receipt))
  check('the record reads killed and its controller is aborted', statusOf(store, id) === 'killed' && spawned.abortController?.signal.aborted === true)
  const { getCommandQueueSnapshot } = await import('../../src/input-core/command-queue.js')
  const stopWords = (await import('../../src/services/agents/operatorStop.js') as { teammateStopWords?: (name: string) => string }).teammateStopWords
  const notice = getCommandQueueSnapshot().find(c => c.mode === 'task-notification' && typeof c.value === 'string' && c.value.includes(`<task-id>${id}</task-id>`))
  check('the main agent is told: the stop queues one task notification naming the teammate and the door that stopped it, at the next priority', stopWords !== undefined && notice !== undefined && typeof notice.value === 'string' && notice.value.includes('<status>killed</status>') && notice.value.includes(`<summary>${stopWords('sonnet-ping')}</summary>`) && notice.priority === 'next', JSON.stringify(notice ?? null))
  const again = await stopAgentByOperator(id, { getAppState: store.get, setAppState: store.set as never }, quick)
  check('a second stop is refused with the row\'s status, never applied', again.outcome === 'refused' && again.reason === notRunningWords('sonnet-ping: reply ping', 'killed'), JSON.stringify(again))
}

section('a dispatched agent: the abort carries the operator\'s reason; applied only once the record left running')
{
  const store = makeStore()
  const task = registerAsyncAgent({ agentId: 'ag-live', description: 'live seat', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  const controller = task.abortController!
  let reasonSeen: unknown = 'unset'
  controller.signal.addEventListener('abort', () => {
    reasonSeen = controller.signal.reason
    setTimeout(() => {
      store.set(((prev: State) => ({ ...prev, tasks: { ...prev.tasks, 'ag-live': { ...(prev.tasks['ag-live'] as object), status: 'killed', stopReason: 'stopped from the crew view' } } })) as never)
    }, 20)
  })
  const receipt = await stopAgentByOperator('ag-live', { getAppState: store.get, setAppState: store.set as never }, quick)
  check('the controller aborted with the crew stop\'s reason', reasonSeen === AGENT_STOP_BY_OPERATOR, String(reasonSeen))
  check('the receipt is applied once the record settled, carrying the settled status', receipt.outcome === 'applied' && receipt.kind === 'agent' && receipt.status === 'killed', JSON.stringify(receipt))
}
{
  const store = makeStore()
  registerAsyncAgent({ agentId: 'ag-deaf', description: 'deaf seat', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  const t0 = Date.now()
  const receipt = await stopAgentByOperator('ag-deaf', { getAppState: store.get, setAppState: store.set as never }, quick)
  check('a loop that never ends within the budget is refused with the words, never applied', receipt.outcome === 'refused' && receipt.reason === unsettledWords('deaf seat', quick.settleMs) && Date.now() - t0 >= quick.settleMs - 5, JSON.stringify(receipt))
}

section('the misses: an unknown id and a settled row are refused, never applied')
{
  const store = makeStore()
  const miss = await stopAgentByOperator('anope1234', { getAppState: store.get, setAppState: store.set as never }, quick)
  check('an id the registry does not hold is refused with the miss words', miss.outcome === 'refused' && miss.reason === bareMissWords('anope1234'), JSON.stringify(miss))
  registerWorkflowTask({ taskId: 'wf-1', script: 'x', workflowRunId: 'run-1', setAppState: store.set as never })
  const wf = await stopAgentByOperator('wf-1', { getAppState: store.get, setAppState: store.set as never }, quick)
  check('a workflow row is killed through its own road and applied', wf.outcome === 'applied' && wf.kind === 'workflow' && statusOf(store, 'wf-1') === 'killed', JSON.stringify(wf))
  const wfAgain = await stopAgentByOperator('wf-1', { getAppState: store.get, setAppState: store.set as never }, quick)
  check('a settled workflow row is refused with its status', wfAgain.outcome === 'refused' && /not running \(status: killed\)/.test(wfAgain.reason), JSON.stringify(wfAgain))
}

section('the address: TaskStop resolves a named teammate\'s agent id and name, a launch name, and a task id as given')
{
  const store = makeStore()
  const spawned = await spawnInProcessTeammate({ name: 'sonnet-ping', teamName: 'ping-team', prompt: 'reply ping', planModeRequired: false }, { setAppState: store.set as never })
  const id = spawned.taskId!
  const state = store.get() as unknown as Parameters<typeof resolveStopTargetId>[1]
  check('the composite agent id resolves to the teammate\'s task id', resolveStopTargetId('sonnet-ping@ping-team', state) === id)
  check('the bare name resolves to the same task', resolveStopTargetId('sonnet-ping', state) === id)
  check('the task id resolves to itself', resolveStopTargetId(id, state) === id)
  check('an unknown address comes back unchanged for the miss words', resolveStopTargetId('nobody@nowhere', state) === 'nobody@nowhere')
  registerAsyncAgent({ agentId: 'ag-named', description: 'named seat', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  store.state.agentNameRegistry.set('scout', 'ag-named')
  check('a launch name the registry routes resolves to its agent\'s task id', resolveStopTargetId('scout', store.get() as never) === 'ag-named')
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} OPERATOR-STOP PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL OPERATOR-STOP PROOFS PASS')
