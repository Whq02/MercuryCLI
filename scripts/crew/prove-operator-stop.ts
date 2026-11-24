#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'operator-stop-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

await import('../../src/engine/tasks/tasks.js')
const { CREWMATE_STOP_SETTLE_MS, notRunningWords, stopCrewmateByOperator, unsettledWords } = await import('../../src/crew/agents/operatorStop.js')
const { CREWMATE_STOP_BY_OPERATOR, registerAsyncCrewmate } = await import('../../src/engine/tasks/local-agent/crewmateTask.js')
const { CREWMATE_VERB_ANSWER_DEADLINE_MS } = await import('../../src/daemon/session-seat/sessionSeat.js')
const { resolveStopTargetId } = await import('../../src/engine/tasks/stopTask.js')
const { bareMissWords } = await import('../../src/engine/tasks/stopTask.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type State = { tasks: Record<string, unknown>; speculation: { status: string }; agentNameRegistry: Map<string, string>; crewContext?: unknown }
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
const FAKE_AGENT_DEF = { agentType: 'mercury-crew', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
const statusOf = (store: ReturnType<typeof makeStore>, id: string): string | undefined => (store.state.tasks[id] as { status?: string } | undefined)?.status
const quick = { settleMs: 300, sleep: (ms: number) => new Promise<void>(r => setTimeout(r, Math.min(ms, 10))) }

section('the budget: the runner settles a stop well inside the seat\'s answer deadline')
check('the settle budget is a fraction of the seat\'s deadline for the answer', CREWMATE_STOP_SETTLE_MS > 0 && CREWMATE_STOP_SETTLE_MS * 2 <= CREWMATE_VERB_ANSWER_DEADLINE_MS, `${CREWMATE_STOP_SETTLE_MS} vs ${CREWMATE_VERB_ANSWER_DEADLINE_MS} — change AGENT_STOP_SETTLE_MS in src/crew/agents/operatorStop.ts (or AGENT_VERB_ANSWER_DEADLINE_MS in src/daemon/session-seat/sessionSeat.ts) so twice the settle budget fits inside the seat's answer deadline`)

section('a dispatched agent: the abort carries the operator\'s reason; applied only once the record left running')
{
  const store = makeStore()
  const task = registerAsyncCrewmate({ agentId: 'ag-live', description: 'live seat', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  const controller = task.abortController!
  let reasonSeen: unknown = 'unset'
  controller.signal.addEventListener('abort', () => {
    reasonSeen = controller.signal.reason
    setTimeout(() => {
      store.set(((prev: State) => ({ ...prev, tasks: { ...prev.tasks, 'ag-live': { ...(prev.tasks['ag-live'] as object), status: 'killed', stopReason: 'stopped from the crew view' } } })) as never)
    }, 20)
  })
  const receipt = await stopCrewmateByOperator('ag-live', { getAppState: store.get, setAppState: store.set as never }, quick)
  check('the controller aborted with the crew stop\'s reason', reasonSeen === CREWMATE_STOP_BY_OPERATOR, `${String(reasonSeen)} — stopAgentByOperator in src/crew/agents/operatorStop.ts must abort the agent's controller with AGENT_STOP_BY_OPERATOR as the reason`)
  check('the receipt is applied once the record settled, carrying the settled status', receipt.outcome === 'applied' && receipt.kind === 'agent' && receipt.status === 'killed', `${JSON.stringify(receipt)} — stopAgentByOperator in src/crew/agents/operatorStop.ts must return an applied agent receipt with the settled status once the row has left running`)
}
{
  const store = makeStore()
  registerAsyncCrewmate({ agentId: 'ag-deaf', description: 'deaf seat', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  const t0 = Date.now()
  const receipt = await stopCrewmateByOperator('ag-deaf', { getAppState: store.get, setAppState: store.set as never }, quick)
  check('a loop that never ends within the budget is refused with the words, never applied', receipt.outcome === 'refused' && receipt.reason === unsettledWords('deaf seat', quick.settleMs) && Date.now() - t0 >= quick.settleMs - 5, `${JSON.stringify(receipt)} — stopAgentByOperator in src/crew/agents/operatorStop.ts must wait the settle budget, then refuse with unsettledWords instead of applying`)
}

section('the misses: an unknown id and a settled row are refused, never applied')
{
  const store = makeStore()
  const miss = await stopCrewmateByOperator('anope1234', { getAppState: store.get, setAppState: store.set as never }, quick)
  check('an id the registry does not hold is refused with the miss words', miss.outcome === 'refused' && miss.reason === bareMissWords('anope1234'), `${JSON.stringify(miss)} — stopAgentByOperator in src/crew/agents/operatorStop.ts must refuse an unknown id with the miss words (taskNotFoundWords in src/engine/tasks/stopTask.ts)`)
  registerAsyncCrewmate({ agentId: 'ag-done', description: 'settled seat', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  store.set(((prev: State) => ({ ...prev, tasks: { ...prev.tasks, 'ag-done': { ...(prev.tasks['ag-done'] as object), status: 'killed' } } })) as never)
  const settled = await stopCrewmateByOperator('ag-done', { getAppState: store.get, setAppState: store.set as never }, quick)
  check('a settled row is refused with its status', settled.outcome === 'refused' && /not running \(status: killed\)/.test(settled.reason) && statusOf(store, 'ag-done') === 'killed', `${JSON.stringify(settled)} — stopAgentByOperator in src/crew/agents/operatorStop.ts must refuse a settled row with notRunningWords and leave its status alone`)
}

section('the address: TaskStop resolves a launch name and a task id as given')
{
  const store = makeStore()
  const state = store.get() as unknown as Parameters<typeof resolveStopTargetId>[1]
  check('an unknown address comes back unchanged for the miss words', resolveStopTargetId('nobody@nowhere', state) === 'nobody@nowhere', 'resolveStopTargetId in src/engine/tasks/stopTask.ts must return an unknown address unchanged')
  registerAsyncCrewmate({ agentId: 'ag-named', description: 'named seat', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  store.state.agentNameRegistry.set('scout', 'ag-named')
  check('a launch name the registry routes resolves to its agent\'s task id', resolveStopTargetId('scout', store.get() as never) === 'ag-named', 'resolveStopTargetId in src/engine/tasks/stopTask.ts must map a name in agentNameRegistry to its task id')
  check('the task id resolves to itself', resolveStopTargetId('ag-named', store.get() as never) === 'ag-named', 'resolveStopTargetId in src/engine/tasks/stopTask.ts must return a task id that is in tasks as given')
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} OPERATOR-STOP PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL OPERATOR-STOP PROOFS PASS')
