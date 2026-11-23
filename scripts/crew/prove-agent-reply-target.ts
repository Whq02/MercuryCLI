#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { makeTally } from './crew-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'agent-reply-target-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { getCommandQueue, resetCommandQueue } = await import('../../src/screen/composer/input-core/command-queue.ts')
const { registerAsyncAgent, enqueueAgentNotification, queuePendingMessage, queueOperatorMessage, drainPendingMessages, completeAgentTask } = await import('../../src/engine/tasks/local-agent/crewmateTask.tsx')
const { createAssistantMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { runAsyncAgentLifecycle, deliverOperatorMessagesAfterStop } = await import('../../src/tools/crewmate/crewmateLifecycle.ts')
const { applyTaskOffsetsAndEvictions } = await import('../../src/engine/task-framework/taskRegistry.ts')
type AppState = ReturnType<typeof getDefaultAppState>
const tally = makeTally('prove-agent-reply-target')
const makeStore = () => {
  let state = getDefaultAppState()
  return { get: () => state, set: (update: (before: AppState) => AppState) => { state = update(state) } }
}
let seq = 0
const freshId = (): string => `a${String(++seq).padStart(8, '0')}`
const NOTIFY = 'enqueueAgentNotification in src/engine/tasks/local-agent/crewmateTask.tsx decides who is told the final answer for a replyTarget and when the task is latched as notified; change it there'
const notes = (): string[] => getCommandQueue().filter(command => command.mode === 'task-notification').map(command => String(command.value))

for (const replyTarget of ['operator', 'parent'] as const) {
  for (const status of ['completed', 'failed', 'killed'] as const) {
    resetCommandQueue()
    const store = makeStore()
    const taskId = freshId()
    const task = registerAsyncAgent({ agentId: taskId, description: 'reply target', prompt: 'answer', replyTarget, setAppState: store.set })
    completeAgentTask({ agentId: taskId }, store.set, task.abortController)
    const notification = { taskId, description: 'reply target', status, setAppState: store.set, controller: task.abortController, replyTarget, finalMessage: 'PRIVATE-OR-PARENT-ANSWER' }
    enqueueAgentNotification(notification)
    enqueueAgentNotification(notification)
    tally.check(`${replyTarget}/${status}: only a parent turn enqueues its answer, exactly once`, replyTarget === 'parent' ? notes().length === 1 && notes()[0]!.includes('PRIVATE-OR-PARENT-ANSWER') : notes().length === 0, `${notes().length} task notification(s) queued; ${NOTIFY}`)
    tally.check(`${replyTarget}/${status}: the notification latch settles without needing a lead inbox mark`, store.get().tasks[taskId]?.notified === true, `notified is ${String(store.get().tasks[taskId]?.notified)}; ${NOTIFY}`)
    store.set(state => ({ ...state, tasks: { ...state.tasks, [taskId]: { ...state.tasks[taskId], retain: false, evictAfter: 0 } as never } }))
    applyTaskOffsetsAndEvictions(store.set, {}, [taskId])
    tally.check(`${replyTarget}/${status}: the settled row can be evicted normally`, store.get().tasks[taskId] === undefined, 'the settled task row is still in state after applyTaskOffsetsAndEvictions in src/engine/task-framework/taskRegistry.ts; a notified task with retain false and evictAfter 0 must be evicted there')
  }
}

for (const oldTarget of ['operator', 'parent'] as const) {
  resetCommandQueue()
  const store = makeStore()
  const taskId = freshId()
  const old = registerAsyncAgent({ agentId: taskId, description: 'old', prompt: 'old', replyTarget: oldTarget, setAppState: store.set })
  const nextTarget = oldTarget === 'operator' ? 'parent' : 'operator'
  const next = registerAsyncAgent({ agentId: taskId, description: 'next', prompt: 'next', replyTarget: nextTarget, setAppState: store.set })
  enqueueAgentNotification({ taskId, description: 'old', status: 'completed', finalMessage: 'OLD-ANSWER', setAppState: store.set, controller: old.abortController, replyTarget: oldTarget })
  tally.check(`${oldTarget}: an old registration never latches its successor`, store.get().tasks[taskId]?.notified !== true, `${NOTIFY} (a notification for an old controller must not latch the task its successor now holds)`)
  enqueueAgentNotification({ taskId, description: 'next', status: 'completed', finalMessage: 'NEXT-ANSWER', setAppState: store.set, controller: next.abortController, replyTarget: nextTarget })
  tally.check(`${oldTarget}: each generation keeps its own recipient`, notes().length === 1 && notes()[0]!.includes(oldTarget === 'parent' ? 'OLD-ANSWER' : 'NEXT-ANSWER'), `${JSON.stringify(notes())}; ${NOTIFY}`)
}

for (const consumed of [false, true]) {
  resetCommandQueue()
  const store = makeStore()
  const taskId = freshId()
  const task = registerAsyncAgent({ agentId: taskId, description: 'mixed', prompt: 'owner chat', replyTarget: 'operator', setAppState: store.set })
  queuePendingMessage(taskId, 'the lead adds a task', store.set)
  if (consumed) drainPendingMessages(taskId, store.get, store.set)
  enqueueAgentNotification({ taskId, description: 'mixed', status: 'completed', finalMessage: 'LEAD-ALSO-OWED', setAppState: store.set, controller: task.abortController, replyTarget: 'operator' })
  tally.check(consumed ? 'a lead message consumed during an owner turn earns the lead its notification' : 'a lead message still queued for another turn never leaks the owner answer', consumed ? notes().length === 1 && notes()[0]!.includes('LEAD-ALSO-OWED') : notes().length === 0, `${notes().length} task notification(s) queued; ${NOTIFY} (and queuePendingMessage / drainPendingMessages in the same file mark which lead messages are owed an answer)`)
}

const resumes: Array<{ replyTarget?: string; prompt: string }> = []
const resumeModule = await import('../../src/tools/crewmate/resumeCrewmate.ts')
mock.module('../../src/tools/crewmate/resumeCrewmate.ts', () => ({ ...resumeModule, resumeAgentBackground: async (args: { replyTarget?: string; prompt: string }) => { resumes.push(args); return {} } }))
for (const kind of ['owner', 'lead', 'mixed', 'stop'] as const) {
  resetCommandQueue()
  const store = makeStore()
  const taskId = freshId()
  const task = registerAsyncAgent({ agentId: taskId, description: kind, prompt: 'work', setAppState: store.set })
  if (kind !== 'lead') queueOperatorMessage(taskId, 'OWNER-NEXT', store.set)
  if (kind === 'lead' || kind === 'mixed') queuePendingMessage(taskId, 'LEAD-NEXT', store.set)
  const context = { getAppState: store.get, setAppState: store.set, setAppStateForTasks: store.set, options: { tools: [] }, abortController: new AbortController(), messages: [] } as never
  if (kind === 'stop') {
    await deliverOperatorMessagesAfterStop(taskId, kind, context, store.set)
  } else {
    async function* stream() { yield createAssistantMessage({ content: 'DONE' }) }
    await runAsyncAgentLifecycle({ taskId, abortController: task.abortController!, makeStream: stream, metadata: { prompt: 'work', resolvedAgentModel: 'fixture', isBuiltInAgent: false, startTime: Date.now(), agentType: 'mercury-crew', isAsync: true }, description: kind, toolUseContext: context, rootSetAppState: store.set, agentIdForCleanup: taskId, enableSummarization: false, getWorktreeResult: async () => ({}) })
  }
  const resumed = resumes.at(-1)
  tally.check(`${kind}: queued follow-ups retain their audience and words at the resume boundary`, resumed?.replyTarget === (kind === 'lead' || kind === 'mixed' ? 'parent' : 'operator') && (kind === 'lead' || resumed.prompt.includes('OWNER-NEXT')) && ((kind !== 'lead' && kind !== 'mixed') || resumed.prompt.includes('LEAD-NEXT')), `${JSON.stringify(resumed)}; runAsyncAgentLifecycle and deliverOperatorMessagesAfterStop in src/tools/crewmate/crewmateLifecycle.ts must resume with the replyTarget and words of the queued follow-ups (queueOperatorMessage and queuePendingMessage in src/engine/tasks/local-agent/crewmateTask.tsx)`)
}
rmSync(home, { recursive: true, force: true })
tally.finish()
