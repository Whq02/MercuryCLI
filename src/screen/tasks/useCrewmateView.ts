import { useMemo } from 'react'
import { crewmatesOf, crewRunning, type CrewmateFacts } from '../../engine/connector/crewFacts.js'
import type { WorkRowV1 } from '../../engine/connector/types.js'
import { useAppStateMaybeOutsideOfProvider, type AppState } from '../app-state/AppState.js'
import { composerTargetTaskId } from '../app-state/selectors.js'
import { isCrewmateTask } from '../../engine/tasks/local-agent/crewmateTask.js'
import type { TaskState } from '../../engine/tasks/taskState.js'
import { projectWorkRoster } from '../../engine/connector/workRoster.js'
import { useCrewLedgerRow } from './useCrewLedger.js'
import { focusedSessionIdOrNull, useFocusedWorkRoster } from './useFocusedWork.js'

export type CrewmateInView = {
  taskId: string
  name: string
  facts: CrewmateFacts | null
  local: TaskState | undefined
  pinned: boolean
  running: number
}

export function crewmateFacts(
  taskId: string,
  local: TaskState | undefined,
  rosterRows: readonly WorkRowV1[],
  sessionId: string | null,
): CrewmateFacts | null {
  if (local !== undefined) {
    const projected = crewmatesOf(projectWorkRoster({ [taskId]: local }), sessionId)
    if (projected[0] !== undefined) return projected[0]
  }
  return crewmatesOf(rosterRows, sessionId).find(agent => agent.id === taskId) ?? null
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

export function crewmateName(taskId: string, local: TaskState | undefined, facts: CrewmateFacts | null): string {
  if (facts !== null) return facts.name
  if (local !== undefined && isCrewmateTask(local)) return local.description !== '' ? local.description : local.agentType
  return taskId
}

export function crewmateInView(
  taskId: string | undefined,
  state: Pick<AppState, 'tasks' | 'mainChatTaskId'>,
  rosterRows: readonly WorkRowV1[],
  sessionId: string | null,
  remembered: CrewmateFacts | null = null,
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
    running: crewRunning(crewmatesOf(rosterRows, sessionId)).length,
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
  const viewing = useAppStateMaybeOutsideOfProvider((s: AppState) => s.viewingCrewmateTaskId)
  return useCrewmate(viewing)
}

export function useComposerCrewmate(): CrewmateInView | null {
  const target = useAppStateMaybeOutsideOfProvider((s: AppState) => composerTargetTaskId(s))
  return useCrewmate(target)
}
