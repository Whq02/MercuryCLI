import type { AppState } from '../state/AppStateStore.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { TEAM_LEAD_NAME } from './swarm/constants.js'
import { getTeammateContext } from './teammateContext.js'


export {
  createTeammateContext,
  getTeammateContext,
  isInProcessTeammate,
  runWithTeammateContext,
} from './teammateContext.js'
export type { TeammateContext } from './teammateContext.js'

export type DynamicTeamContext = {
  agentId: string
  agentName: string
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId?: string
}

let dynamicTeamContext: DynamicTeamContext | null = null

export function setDynamicTeamContext(context: DynamicTeamContext | null): void {
  dynamicTeamContext = context
}

export function clearDynamicTeamContext(): void {
  dynamicTeamContext = null
}

export function getDynamicTeamContext(): DynamicTeamContext | null {
  return dynamicTeamContext
}

export function getParentSessionId(): string | undefined {
  const context = getTeammateContext()
  if (context) return context.parentSessionId
  return dynamicTeamContext?.parentSessionId
}

export function getAgentId(): string | undefined {
  const context = getTeammateContext()
  if (context) return context.agentId
  return dynamicTeamContext?.agentId
}

export function getAgentName(): string | undefined {
  const context = getTeammateContext()
  if (context) return context.agentName
  return dynamicTeamContext?.agentName
}

export function getTeammateColor(): string | undefined {
  const context = getTeammateContext()
  if (context) return context.color
  return dynamicTeamContext?.color
}

export function resolveCoordAgentId(): string {
  return getAgentName() ?? TEAM_LEAD_NAME
}

export function getTeamName(teamContext?: { teamName: string }): string | undefined {
  const context = getTeammateContext()
  if (context) return context.teamName
  if (dynamicTeamContext && dynamicTeamContext.teamName !== '') return dynamicTeamContext.teamName
  return teamContext?.teamName
}

let leadTeamFallback: string | null = null

export function setLeadTeamFallback(teamName: string | null): void {
  leadTeamFallback = teamName
}

export function getLeadTeamFallback(): string | null {
  return leadTeamFallback
}

export function resolveLeadAwareTeamName(teamContext?: { teamName: string }): string | undefined {
  return getTeamName(teamContext) ?? leadTeamFallback ?? undefined
}

export function isTeammate(): boolean {
  if (getTeammateContext() !== undefined) return true
  return (
    dynamicTeamContext !== null &&
    dynamicTeamContext.agentId !== '' &&
    dynamicTeamContext.teamName !== ''
  )
}

export function isPlanModeRequired(): boolean {
  const context = getTeammateContext()
  if (context) return context.planModeRequired
  if (dynamicTeamContext !== null) return dynamicTeamContext.planModeRequired
  return false
}

export function isTeamLead(teamContext: { leadAgentId: string } | undefined): boolean {
  if (!teamContext?.leadAgentId) return false
  const agentId = getAgentId()
  if (agentId === undefined) return true
  return agentId === teamContext.leadAgentId
}

export function hasActiveInProcessTeammates(appState: AppState): boolean {
  return Object.values(appState.tasks).some(
    task => isInProcessTeammateTask(task) && task.status === 'running',
  )
}

export function hasWorkingInProcessTeammates(appState: AppState): boolean {
  return Object.values(appState.tasks).some(
    task => isInProcessTeammateTask(task) && task.status === 'running' && !task.isIdle,
  )
}

export function waitForTeammatesToBecomeIdle(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  appState: AppState,
): Promise<void> {
  const waitingIds = Object.entries(appState.tasks)
    .filter(([, task]) => isInProcessTeammateTask(task) && task.status === 'running' && !task.isIdle)
    .map(([taskId]) => taskId)
  if (waitingIds.length === 0) return Promise.resolve()

  return new Promise(resolve => {
    let outstanding = waitingIds.length
    const settleOne = (): void => {
      outstanding--
      if (outstanding === 0) resolve()
    }
    setAppState(prev => {
      const nextTasks = { ...prev.tasks }
      for (const taskId of waitingIds) {
        const task = nextTasks[taskId]
        if (!isInProcessTeammateTask(task)) continue
        if (task.isIdle) {
          settleOne()
          continue
        }
        nextTasks[taskId] = {
          ...task,
          onIdleCallbacks: [...(task.onIdleCallbacks ?? []), settleOne],
        }
      }
      return { ...prev, tasks: nextTasks }
    })
  })
}
