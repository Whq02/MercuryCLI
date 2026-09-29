import { useMemo } from 'react'
import { crewAgentsOf, crewRunning, type CrewAgentFacts } from '../../services/engine-connector/crewFacts.js'
import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import { useAppStateMaybeOutsideOfProvider, type AppState } from '../../state/AppState.js'
import { composerTargetTaskId } from '../../state/selectors.js'
import { isInProcessCrewmateTask } from '../../tasks/InProcessCrewmateTask/types.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import { projectWorkRoster } from '../../utils/task/workRoster.js'
import { useCrewLedgerRow } from './useCrewLedger.js'
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

export function crewmateLive(crewmate: Pick<CrewmateInView, 'facts'> | null): boolean {
  return crewmate === null || crewmate.facts === null || crewmate.facts.running
}

export function viewedWords(crewmate: CrewmateInView | null): { name: string; live: boolean } | null {
  return crewmate === null ? null : { name: crewmate.name, live: crewmateLive(crewmate) }
}

export function targetWords(crewmate: CrewmateInView): { name: string; pinned: boolean; live: boolean; local: boolean } {
  return { name: crewmate.name, pinned: crewmate.pinned, live: crewmateLive(crewmate), local: crewmate.local !== undefined }
}

export function crewmateName(taskId: string, local: TaskState | undefined, facts: CrewAgentFacts | null): string {
  if (facts !== null) return facts.name
  if (local !== undefined && isInProcessCrewmateTask(local)) return local.identity.agentName
  if (local !== undefined && isLocalAgentTask(local)) return local.description !== '' ? local.description : local.agentType
  return taskId
}

export function crewmateInView(
  taskId: string | undefined,
  state: Pick<AppState, 'tasks' | 'mainChatTaskId'>,
  rosterRows: readonly WorkRowV1[],
  sessionId: string | null,
  remembered: CrewAgentFacts | null = null,
): CrewmateInView | null {
  if (taskId === undefined) return null
  const local = state.tasks[taskId]
  const facts = crewmateFacts(taskId, local, rosterRows, sessionId) ?? remembered
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
  const remembered = useCrewLedgerRow(taskId)
  return useMemo(
    () => crewmateInView(taskId, { tasks: taskId === undefined || local === undefined ? {} : { [taskId]: local }, mainChatTaskId }, roster.rows, sessionId, remembered?.facts ?? null),
    [taskId, local, mainChatTaskId, roster, sessionId, remembered],
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
