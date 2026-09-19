import type { SetAppState } from '../../Task.js'
import type { AppState } from '../../state/AppState.js'
import { stopOrDismissAgent } from '../../state/teammateViewHelpers.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { AGENT_STOP_BY_OPERATOR, isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalWorkflowTask, killWorkflowTask } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { StopTaskError, stopTask, taskNotFoundWords } from '../../tasks/stopTask.js'
import { killInProcessTeammate } from '../../utils/swarm/spawnInProcess.js'

export const AGENT_STOP_SETTLE_MS = 3_000
const SETTLE_TICK_MS = 50

export type OperatorStopKind = 'agent' | 'teammate' | 'workflow' | 'task'

export type OperatorStopReceipt =
  | { outcome: 'applied'; kind: OperatorStopKind; status: string }
  | { outcome: 'refused'; reason: string }

export type OperatorStopContext = {
  getAppState: () => AppState
  setAppState: SetAppState
}

export type OperatorStopOptions = {
  settleMs?: number
  sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function nameOf(task: { description?: string; id: string }): string {
  return typeof task.description === 'string' && task.description !== '' ? task.description : task.id
}

export function notRunningWords(name: string, status: string): string {
  return `${name} is not running (status: ${status}) — nothing to stop`
}

export function unsettledWords(name: string, settleMs: number): string {
  return `the stop reached ${name} but it has not ended within ${Math.round(settleMs / 1000)} s — its tool may be ignoring the stop; the row follows when it ends`
}

export async function stopAgentByOperator(
  taskId: string,
  context: OperatorStopContext,
  options: OperatorStopOptions = {},
): Promise<OperatorStopReceipt> {
  const settleMs = options.settleMs ?? AGENT_STOP_SETTLE_MS
  const sleep = options.sleep ?? wait
  const task = context.getAppState().tasks?.[taskId]
  if (task === undefined) return { outcome: 'refused', reason: await taskNotFoundWords(taskId) }
  const name = nameOf(task)
  if (task.status !== 'running') return { outcome: 'refused', reason: notRunningWords(name, task.status) }
  if (isInProcessTeammateTask(task)) {
    const killed = killInProcessTeammate(taskId, context.setAppState)
    if (!killed) return { outcome: 'refused', reason: notRunningWords(name, context.getAppState().tasks?.[taskId]?.status ?? 'gone') }
    return { outcome: 'applied', kind: 'teammate', status: context.getAppState().tasks?.[taskId]?.status ?? 'killed' }
  }
  if (isLocalWorkflowTask(task)) {
    const receipt = killWorkflowTask(taskId, context.setAppState)
    if (receipt !== 'applied') return { outcome: 'refused', reason: `the workflow run ${name} had already settled (${receipt}) — nothing to stop` }
    return { outcome: 'applied', kind: 'workflow', status: context.getAppState().tasks?.[taskId]?.status ?? 'killed' }
  }
  if (isLocalAgentTask(task)) {
    stopOrDismissAgent(taskId, context.setAppState, AGENT_STOP_BY_OPERATOR)
    const signalled = context.getAppState().tasks?.[taskId]
    if (isLocalAgentTask(signalled) && signalled.status === 'running' && signalled.abortController !== undefined && !signalled.abortController.signal.aborted) {
      return { outcome: 'refused', reason: `the stop did not reach ${name} — its controller stands unaborted` }
    }
    const until = Date.now() + settleMs
    for (;;) {
      const now = context.getAppState().tasks?.[taskId]
      if (now === undefined) return { outcome: 'applied', kind: 'agent', status: 'gone' }
      if (now.status !== 'running') return { outcome: 'applied', kind: 'agent', status: now.status }
      if (Date.now() >= until) return { outcome: 'refused', reason: unsettledWords(name, settleMs) }
      await sleep(SETTLE_TICK_MS)
    }
  }
  try {
    await stopTask(taskId, context)
    return { outcome: 'applied', kind: 'task', status: context.getAppState().tasks?.[taskId]?.status ?? 'killed' }
  } catch (error) {
    if (error instanceof StopTaskError) return { outcome: 'refused', reason: error.message }
    return { outcome: 'refused', reason: error instanceof Error ? error.message : String(error) }
  }
}
