#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'crew-group-wait-home-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

await import('../../src/engine/tasks/tasks.js')
const task = await import('../../src/engine/tasks/local-agent/crewmateTask.js')
const receipts = await import('../../src/engine/tasks/local-agent/launchReceipts.js')
const queue = await import('../../src/daemon/runner/messageQueueManager.js')

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
const FAKE_AGENT_DEF = { agentType: 'mercury-crew', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
const settled = (p: Promise<void>): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 150))])

section('G1 — two foreground seats; one fails, the other\'s wait is released at once')
{
  task.resetSiblingEnds()
  const store = makeStore()
  const a = task.registerCrewmateForeground({ agentId: 'seat-a', description: 'reads the tree', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  const b = task.registerCrewmateForeground({ agentId: 'seat-b', description: 'writes the plan', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  check('both seats wait in the foreground', !(store.state.tasks['seat-a'] as { isBackgrounded: boolean }).isBackgrounded && !(store.state.tasks['seat-b'] as { isBackgrounded: boolean }).isBackgrounded, 'registerAgentForeground in src/engine/tasks/local-agent/crewmateTask.tsx must register each seat as a foreground (not backgrounded) task')
  check('neither wait is released before anything ends', !(await settled(a.backgroundSignal)) && !(await settled(b.backgroundSignal)), 'a foreground seat\'s backgroundSignal from registerAgentForeground in src/engine/tasks/local-agent/crewmateTask.tsx must stay pending until a sibling ends')
  task.failCrewmateTask('seat-a', 'the provider refused', store.set as never, a.abortController)
  check('the sibling\'s failure releases the other seat\'s wait now', await settled(b.backgroundSignal), 'failAgentTask in src/engine/tasks/local-agent/crewmateTask.tsx must release the other foreground seats\' backgroundSignal when a seat fails')
  check('…and hands its run to the background', (store.state.tasks['seat-b'] as { isBackgrounded: boolean; status: string }).isBackgrounded === true && (store.state.tasks['seat-b'] as { status: string }).status === 'running', JSON.stringify(store.state.tasks['seat-b']) + ' — the sibling release in src/engine/tasks/local-agent/crewmateTask.tsx must mark the other seat backgrounded and still running')
  const end = task.takeSiblingEnd('seat-b')
  check('the seat that hands over takes the sibling\'s end once', end !== null && end.taskId === 'seat-a' && end.status === 'failed' && end.error === 'the provider refused' && end.description === 'reads the tree' && task.takeSiblingEnd('seat-b') === null, JSON.stringify(end) + ' — takeSiblingEnd in src/engine/tasks/local-agent/crewmateTask.tsx must return the failed sibling\'s end once, then null')
  check('the failed seat itself takes no end', task.takeSiblingEnd('seat-a') === null, 'takeSiblingEnd in src/engine/tasks/local-agent/crewmateTask.tsx must give the failed seat itself no sibling end')
  const c = task.registerCrewmateForeground({ agentId: 'seat-c', description: 'third', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  const d = task.registerCrewmateForeground({ agentId: 'seat-d', description: 'fourth', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.settleCrewmateForeground('seat-c', 'completed', store.set as never)
  check('a completion releases nothing: the sibling keeps waiting', !(await settled(d.backgroundSignal)) && task.takeSiblingEnd('seat-d') === null, 'settleAgentForeground with completed in src/engine/tasks/local-agent/crewmateTask.tsx must not release siblings or record a sibling end')
  const e = task.registerCrewmateForeground({ agentId: 'seat-e', description: 'fifth', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.killAsyncCrewmate('seat-d', store.set as never, 'stopped from the crew view', d.abortController)
  check('a stop releases the siblings with the stop\'s words', (await settled(e.backgroundSignal)) && task.takeSiblingEnd('seat-e')?.status === 'stopped' && (store.state.tasks['seat-e'] as { isBackgrounded: boolean }).isBackgrounded === true, 'killAsyncAgent in src/engine/tasks/local-agent/crewmateTask.tsx must release the sibling foreground seats and record a stopped sibling end')
  void c
}

section('G2 — a child\'s terminal notice rides the band the turn machine drains at its next tool result')
{
  queue.resetCommandQueue()
  const store = makeStore()
  task.registerAsyncCrewmate({ agentId: 'bg-3', description: 'notifier', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.failCrewmateTask('bg-3', 'the provider refused', store.set as never)
  task.enqueueCrewmateNotification({ taskId: 'bg-3', description: 'notifier', status: 'failed', error: 'the provider refused', setAppState: store.set as never })
  const notices = queue.getCommandQueueSnapshot().filter(c => c.mode === 'task-notification')
  check('one notice, on the next band (never the later band a sleep alone drains)', notices.length === 1 && notices[0]?.priority === 'next', JSON.stringify(notices.map(n => n.priority)) + ' — enqueueAgentNotification in src/engine/tasks/local-agent/crewmateTask.tsx must queue the terminal notice with priority next')
  check('the mid-turn drain at a tool-round boundary (no sleep) takes it', queue.getDrainableCommands(false).some(c => c.mode === 'task-notification'), 'the notice must be drainable by getDrainableCommands(false) in src/daemon/runner/messageQueueManager.ts; check the priority enqueueAgentNotification in src/engine/tasks/local-agent/crewmateTask.tsx gives it')
  check('the notice names the failure and the way back', String(notices[0]?.value ?? '').includes('failed: the provider refused') && String(notices[0]?.value ?? '').includes('its work is kept'), String(notices[0]?.value ?? '').slice(0, 300) + ' — enqueueAgentNotification in src/engine/tasks/local-agent/crewmateTask.tsx must name the failure and say its work is kept')
  queue.resetCommandQueue()
}

section('G3 — the hand-over receipt names the sibling and its end')
{
  const line = receipts.foregroundNotKeptLine('sibling-ended', { taskId: 'seat-a', description: 'reads the tree', status: 'failed', error: 'the provider refused' })
  check('the sibling line', line === 'The foreground request was not kept: a wait on a group returns the moment any member fails or stops — crewmate "reads the tree" [seat-a] failed (the provider refused); read its result now, and this crewmate runs on in the background (its own notice follows).', line + ' — foregroundNotKeptLine in src/engine/tasks/local-agent/launchReceipts.ts must keep this sibling-ended line word for word')
  check('a stop without words', receipts.foregroundNotKeptLine('sibling-ended', { taskId: 'seat-d', description: 'fourth', status: 'stopped' }).includes('crewmate "fourth" [seat-d] stopped; read its result now'), 'foregroundNotKeptLine in src/engine/tasks/local-agent/launchReceipts.ts must say stopped with no parenthesised words when the sibling gave none')
  check('the other reasons keep their lines', receipts.foregroundNotKeptLine('turn-interrupted').startsWith('The foreground request was not kept: the turn it ran in was interrupted'), 'foregroundNotKeptLine in src/engine/tasks/local-agent/launchReceipts.ts must keep the turn-interrupted line')
}

console.log(failures === 0 ? '\nprove-crew-group-wait: all green' : `\nprove-crew-group-wait: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
