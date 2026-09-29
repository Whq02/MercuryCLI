import type { AppState } from '../state/AppStateStore.js'
import { isInProcessCrewmateTask, type InProcessCrewmateTaskState } from '../tasks/InProcessCrewmateTask/types.js'
import { updateTaskState } from './task/framework.js'
import type { PlanApprovalResponseMessage } from './crewmateMailbox.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void


export function findInProcessCrewmateTaskId(agentName: string, appState: AppState): string | undefined {
  for (const [taskId, task] of Object.entries(appState.tasks ?? {})) {
    if (isInProcessCrewmateTask(task) && task.identity.agentName === agentName) return taskId
  }
  return undefined
}

export function setAwaitingPlanApproval(taskId: string, setAppState: SetAppState, awaiting: boolean): void {
  updateTaskState<InProcessCrewmateTaskState>(taskId, setAppState, task => ({ ...task, awaitingPlanApproval: awaiting }))
}

export function handlePlanApprovalResponse(
  taskId: string,
  _response: PlanApprovalResponseMessage,
  setAppState: SetAppState,
): void {
  setAwaitingPlanApproval(taskId, setAppState, false)
}
