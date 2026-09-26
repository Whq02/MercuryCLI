import { useMemo } from 'react'
import { crewAgentsOf, crewRunning, type CrewAgentFacts } from '../../services/engine-connector/crewFacts.js'
import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import { useAppStateMaybeOutsideOfProvider, type AppState } from '../../state/AppState.js'
import { composerTargetTaskId } from '../../state/selectors.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import { projectWorkRoster } from '../../utils/task/workRoster.js'
import { focusedSessionIdOrNull, useFocusedWorkRoster } from './useFocusedWork.js'

export type CrewmateInView = {
  taskId: string
  name: string
  facts: CrewAgentFacts | null
  local: TaskState | undefined
  pinned: boolean
  running: number
}

export function crewmateFacts(
  taskId: string,
  local: TaskState | undefined,
  rosterRows: readonly WorkRowV1[],
  sessionId: string | null,
): CrewAgentFacts | null {
  if (local !== undefined) {
    const projected = crewAgentsOf(projectWorkRoster({ [taskId]: local }), sessionId)
    if (projected[0] !== undefined) return projected[0]
  }
  return crewAgentsOf(rosterRows, sessionId).find(agent => agent.id === taskId) ?? null
}

export function crewmateName(taskId: string, local: TaskState | undefined, facts: CrewAgentFacts | null): string {
  if (facts !== null) return facts.name
  if (local !== undefined && isInProcessTeammateTask(local)) return local.identity.agentName
  if (local !== undefined && isLocalAgentTask(local)) return local.description !== '' ? local.description : local.agentType
  return taskId
}

export function crewmateInView(
  taskId: string | undefined,
  state: Pick<AppState, 'tasks' | 'mainChatTaskId'>,
  rosterRows: readonly WorkRowV1[],
  sessionId: string | null,
): CrewmateInView | null {
  if (taskId === undefined) return null
  const local = state.tasks[taskId]
  const facts = crewmateFacts(taskId, local, rosterRows, sessionId)
  return {
    taskId,
    name: crewmateName(taskId, local, facts),
    facts,
    local,
    pinned: state.mainChatTaskId === taskId,
    running: crewRunning(crewAgentsOf(rosterRows, sessionId)).length,
  }
}

function useCrewmate(taskId: string | undefined): CrewmateInView | null {
  const local = useAppStateMaybeOutsideOfProvider((s: AppState) => (taskId === undefined ? undefined : s.tasks[taskId]))
  const mainChatTaskId = useAppStateMaybeOutsideOfProvider((s: AppState) => s.mainChatTaskId)
  const roster = useFocusedWorkRoster()
  const sessionId = focusedSessionIdOrNull()
  return useMemo(
    () => crewmateInView(taskId, { tasks: taskId === undefined || local === undefined ? {} : { [taskId]: local }, mainChatTaskId }, roster.rows, sessionId),
    [taskId, local, mainChatTaskId, roster, sessionId],
  )
}

export function useViewedCrewmate(): CrewmateInView | null {
  const viewing = useAppStateMaybeOutsideOfProvider((s: AppState) => s.viewingAgentTaskId)
  return useCrewmate(viewing)
}

export function useComposerCrewmate(): CrewmateInView | null {
  const target = useAppStateMaybeOutsideOfProvider((s: AppState) => composerTargetTaskId(s))
  return useCrewmate(target)
}
