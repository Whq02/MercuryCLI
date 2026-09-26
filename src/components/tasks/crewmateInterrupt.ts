import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { SetAppState } from '../../Task.js'
import type { AppState } from '../../state/AppStateStore.js'
import { stopOrDismissAgent } from '../../state/teammateViewHelpers.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { AGENT_INTERRUPT_BY_OPERATOR, isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'

export type CrewmateInterruptRoad = 'local' | 'teammate' | 'hosted' | 'idle'

export type CrewmateInterruptOptions = {
  facts?: { running: boolean } | null
  onRefused?: (detail: string) => void
}

export function interruptCrewmate(
  taskId: string,
  state: Pick<AppState, 'tasks'>,
  setAppState: SetAppState,
  stopAgent: (agentId: string, note?: string) => Promise<unknown> = (agentId, note) => getFocusedSessionConnector().stopAgent(agentId, note),
  options: CrewmateInterruptOptions = {},
): CrewmateInterruptRoad {
  const task = state.tasks[taskId]
  if (task !== undefined && isLocalAgentTask(task)) {
    if (task.status !== 'running') return 'idle'
    stopOrDismissAgent(taskId, setAppState, AGENT_INTERRUPT_BY_OPERATOR)
    return 'local'
  }
  if (task !== undefined && isInProcessTeammateTask(task)) {
    const controller = task.currentWorkAbortController
    if (task.status !== 'running' || controller === undefined) return 'idle'
    controller.abort(AGENT_INTERRUPT_BY_OPERATOR)
    return 'teammate'
  }
  if (options.facts !== undefined && options.facts !== null && !options.facts.running) return 'idle'
  void stopAgent(taskId, AGENT_INTERRUPT_BY_OPERATOR).then(receipt => {
    const answer = receipt as { outcome?: string; detail?: string } | undefined
    if (answer?.outcome === 'refused') options.onRefused?.(answer.detail ?? 'no reason given')
  }, () => {})
  return 'hosted'
}
