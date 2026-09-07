#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'crew-group-wait-home-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

await import('../../src/tasks.js')
const task = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const receipts = await import('../../src/tasks/LocalAgentTask/launchReceipts.js')
const queue = await import('../../src/utils/messageQueueManager.js')
const { TaskOutputTool } = await import('../../src/tools/TaskOutputTool/TaskOutputTool.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Store = { state: { tasks: Record<string, unknown>; speculation: { status: string } } }
function makeStore(): Store & { set: (fn: (prev: never) => never) => void; get: () => unknown } {
  const store = {
    state: { tasks: {}, speculation: { status: 'idle' } } as Store['state'],
    set(fn: (prev: never) => never) {
      store.state = (fn as (p: unknown) => Store['state'])(store.state)
    },
    get() {
      return store.state
    },
  }
  return store
}
const FAKE_AGENT_DEF = { agentType: 'mercury-general', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
const settled = (p: Promise<void>): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 150))])

section('G1 — two foreground seats; one fails, the other\'s wait is released at once')
{
  task.resetSiblingEnds()
  const store = makeStore()
  const a = task.registerAgentForeground({ agentId: 'seat-a', description: 'reads the tree', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  const b = task.registerAgentForeground({ agentId: 'seat-b', description: 'writes the plan', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  check('both seats wait in the foreground', !(store.state.tasks['seat-a'] as { isBackgrounded: boolean }).isBackgrounded && !(store.state.tasks['seat-b'] as { isBackgrounded: boolean }).isBackgrounded)
  check('neither wait is released before anything ends', !(await settled(a.backgroundSignal)) && !(await settled(b.backgroundSignal)))
  task.failAgentTask('seat-a', 'the provider refused', store.set as never, a.abortController)
  check('the sibling\'s failure releases the other seat\'s wait now', await settled(b.backgroundSignal))
  check('…and hands its run to the background', (store.state.tasks['seat-b'] as { isBackgrounded: boolean; status: string }).isBackgrounded === true && (store.state.tasks['seat-b'] as { status: string }).status === 'running')
  const end = task.takeSiblingEnd('seat-b')
  check('the seat that hands over takes the sibling\'s end once', end !== null && end.taskId === 'seat-a' && end.status === 'failed' && end.error === 'the provider refused' && end.description === 'reads the tree' && task.takeSiblingEnd('seat-b') === null, JSON.stringify(end))
  check('the failed seat itself takes no end', task.takeSiblingEnd('seat-a') === null)
  const c = task.registerAgentForeground({ agentId: 'seat-c', description: 'third', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  const d = task.registerAgentForeground({ agentId: 'seat-d', description: 'fourth', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.settleAgentForeground('seat-c', 'completed', store.set as never)
  check('a completion releases nothing: the sibling keeps waiting', !(await settled(d.backgroundSignal)) && task.takeSiblingEnd('seat-d') === null)
  const e = task.registerAgentForeground({ agentId: 'seat-e', description: 'fifth', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.killAsyncAgent('seat-d', store.set as never, 'stopped from the crew view', d.abortController)
  check('a stop releases the siblings with the stop\'s words', (await settled(e.backgroundSignal)) && task.takeSiblingEnd('seat-e')?.status === 'stopped' && (store.state.tasks['seat-e'] as { isBackgrounded: boolean }).isBackgrounded === true)
  void c
}

section('G2 — the blocking read returns early on a sibling\'s failure, naming it')
{
  task.resetSiblingEnds()
  const store = makeStore()
  task.registerAsyncAgent({ agentId: 'bg-1', description: 'long job', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.registerAsyncAgent({ agentId: 'bg-2', description: 'short job', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  const context = {
    getAppState: store.get,
    setAppState: store.set,
    abortController: new AbortController(),
    options: { tools: [] },
  } as never
  const started = Date.now()
  setTimeout(() => task.failAgentTask('bg-2', 'crashed on a bad file', store.set as never), 250)
  const result = (await TaskOutputTool.call({ task_id: 'bg-1', block: true, timeout: 5_000 } as never, context, undefined as never, undefined as never)) as { data: { retrieval_status: string; task: { task_id: string; status: string } | null; interrupted_by?: { task_id: string; status: string; error?: string; description: string } } }
  const elapsed = Date.now() - started
  check('the wait returned when the sibling failed, not at its own timeout', elapsed >= 200 && elapsed < 2_000, String(elapsed))
  check('the waited task runs on and the read says which member ended', result.data.retrieval_status === 'timeout' && result.data.task?.task_id === 'bg-1' && result.data.task.status === 'running' && result.data.interrupted_by?.task_id === 'bg-2' && result.data.interrupted_by.status === 'failed' && result.data.interrupted_by.error === 'crashed on a bad file', JSON.stringify(result.data))
  const block = TaskOutputTool.mapToolResultToToolResultBlockParam(result.data as never, 'toolu_x') as { content: string }
  check('the tool result names the member and its state', /<interrupted_by>the wait ended early: agent "short job" \[bg-2\] failed — crashed on a bad file; the waited task runs on/.test(block.content), block.content)
  const before = (await TaskOutputTool.call({ task_id: 'bg-1', block: true, timeout: 400 } as never, context, undefined as never, undefined as never)) as { data: { retrieval_status: string; interrupted_by?: unknown } }
  check('an end from before the wait began does not return a later wait', before.data.retrieval_status === 'timeout' && before.data.interrupted_by === undefined, JSON.stringify(before.data))
}

section('G3 — a child\'s terminal notice rides the band the turn machine drains at its next tool result')
{
  queue.resetCommandQueue()
  const store = makeStore()
  task.registerAsyncAgent({ agentId: 'bg-3', description: 'notifier', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.failAgentTask('bg-3', 'the provider refused', store.set as never)
  task.enqueueAgentNotification({ taskId: 'bg-3', description: 'notifier', status: 'failed', error: 'the provider refused', setAppState: store.set as never })
  const notices = queue.getCommandQueueSnapshot().filter(c => c.mode === 'task-notification')
  check('one notice, on the next band (never the later band a sleep alone drains)', notices.length === 1 && notices[0]?.priority === 'next', JSON.stringify(notices.map(n => n.priority)))
  check('the mid-turn drain at a tool-round boundary (no sleep) takes it', queue.getDrainableCommands(false).some(c => c.mode === 'task-notification'))
  check('the notice names the failure and the way back', String(notices[0]?.value ?? '').includes('failed: the provider refused') && String(notices[0]?.value ?? '').includes('its work is kept'))
  queue.resetCommandQueue()
}

section('G4 — the hand-over receipt names the sibling and its end')
{
  const line = receipts.foregroundNotKeptLine('sibling-ended', { taskId: 'seat-a', description: 'reads the tree', status: 'failed', error: 'the provider refused' })
  check('the sibling line', line === 'The foreground request was not kept: a wait on a group returns the moment any member fails or stops — agent "reads the tree" [seat-a] failed (the provider refused); read its result now, and this agent runs on in the background (its own notice follows).', line)
  check('a stop without words', receipts.foregroundNotKeptLine('sibling-ended', { taskId: 'seat-d', description: 'fourth', status: 'stopped' }).includes('agent "fourth" [seat-d] stopped; read its result now'))
  check('the other reasons keep their lines', receipts.foregroundNotKeptLine('turn-interrupted').startsWith('The foreground request was not kept: the turn it ran in was interrupted'))
}

console.log(failures === 0 ? '\nprove-crew-group-wait: all green' : `\nprove-crew-group-wait: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
