import type { SetAppState } from '../../engine/tasks/taskBase.js'
import type { AppState } from '../../screen/app-state/AppState.js'
import { stopOrDismissAgent } from '../crewmates/crewmateView.js'
import { AGENT_STOP_BY_OPERATOR, isLocalAgentTask } from '../../engine/tasks/local-agent/crewmateTask.js'
import { isPausedAgentRow, StopTaskError, stopPausedAgent, stopTask, taskNotFoundWords } from '../../engine/tasks/stopTask.js'
import { sleep } from '../../platform/async/sleep.js'

export const AGENT_STOP_SETTLE_MS = 3_000
const SETTLE_TICK_MS = 50

type OperatorStopKind = 'agent' | 'workflow' | 'task'

type OperatorStopReceipt =
  | { outcome: 'applied'; kind: OperatorStopKind; status: string }
  | { outcome: 'refused'; reason: string }

type OperatorStopContext = {
  getAppState: () => AppState
  setAppState: SetAppState
}

type OperatorStopOptions = {
  settleMs?: number
  sleep?: (ms: number) => Promise<void>
  reason?: string
}


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
  const pause = options.sleep ?? sleep
  const task = context.getAppState().tasks?.[taskId]
  if (task === undefined) return { outcome: 'refused', reason: await taskNotFoundWords(taskId) }
  const name = nameOf(task)
  if (isPausedAgentRow(task)) {
    const stopped = await stopPausedAgent(taskId, context)
    if (stopped !== null) return { outcome: 'applied', kind: 'agent', status: context.getAppState().tasks?.[taskId]?.status ?? 'killed' }
  }
  if (task.status !== 'running') return { outcome: 'refused', reason: notRunningWords(name, task.status) }
  if (isLocalAgentTask(task)) {
    stopOrDismissAgent(taskId, context.setAppState, options.reason ?? AGENT_STOP_BY_OPERATOR)
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
      await pause(SETTLE_TICK_MS)
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
