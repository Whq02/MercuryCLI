import type { AppState } from '../state/AppStateStore.js'
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { updateTaskState } from './task/framework.js'
import type { PlanApprovalResponseMessage } from './teammateMailbox.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void


export function findInProcessTeammateTaskId(agentName: string, appState: AppState): string | undefined {
  for (const [taskId, task] of Object.entries(appState.tasks ?? {})) {
    if (isInProcessTeammateTask(task) && task.identity.agentName === agentName) return taskId
  }
  return undefined
}

export function setAwaitingPlanApproval(taskId: string, setAppState: SetAppState, awaiting: boolean): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => ({ ...task, awaitingPlanApproval: awaiting }))
}

export function handlePlanApprovalResponse(
  taskId: string,
  _response: PlanApprovalResponseMessage,
  setAppState: SetAppState,
): void {
  setAwaitingPlanApproval(taskId, setAppState, false)
}
