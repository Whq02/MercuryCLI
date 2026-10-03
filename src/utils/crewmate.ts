import type { AppState } from '../state/AppStateStore.js'
import { isInProcessCrewmateTask } from '../tasks/InProcessCrewmateTask/types.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { getAgentContext, isSubagentContext } from './agentContext.js'
import { CREW_LEAD_NAME } from './crew/constants.js'
import { getCrewmateContext } from './crewmateContext.js'
import { isCrewRole } from './workerRole.js'


export {
  createCrewmateContext,
  getCrewmateContext,
  isInProcessCrewmate,
  runWithCrewmateContext,
} from './crewmateContext.js'
export type { CrewmateContext } from './crewmateContext.js'

export type DynamicCrewContext = {
  agentId: string
  agentName: string
  crewName: string
  color?: string
  parentSessionId?: string
}

let dynamicCrewContext: DynamicCrewContext | null = null

export function setDynamicCrewContext(context: DynamicCrewContext | null): void {
  dynamicCrewContext = context
}

export function clearDynamicCrewContext(): void {
  dynamicCrewContext = null
}

export function getDynamicCrewContext(): DynamicCrewContext | null {
  return dynamicCrewContext
}

export function getParentSessionId(): string | undefined {
  const context = getCrewmateContext()
  if (context) return context.parentSessionId
  return dynamicCrewContext?.parentSessionId
}

export function getAgentId(): string | undefined {
  const context = getCrewmateContext()
  if (context) return context.agentId
  return dynamicCrewContext?.agentId
}

export function getAgentName(): string | undefined {
  const context = getCrewmateContext()
  if (context) return context.agentName
  return dynamicCrewContext?.agentName
}

export function getCrewmateColor(): string | undefined {
  const context = getCrewmateContext()
  if (context) return context.color
  return dynamicCrewContext?.color
}

const MAIN_SESSION_SIDECHAIN = 'main-session'

export function crewChildName(): string | undefined {
  if (!isCrewRole()) return undefined
  const name = flagEnv('MERCURY_CREW_AGENT')
  return name !== undefined && name.trim() !== '' ? name.trim() : undefined
}

export function resolveCoordAgentId(): string {
  const context = getAgentContext()
  if (isSubagentContext(context) && context.subagentName !== MAIN_SESSION_SIDECHAIN) return context.agentId
  return getAgentName() ?? crewChildName() ?? CREW_LEAD_NAME
}

export function getCrewName(crewContext?: { crewName: string }): string | undefined {
  const context = getCrewmateContext()
  if (context) return context.crewName
  if (dynamicCrewContext && dynamicCrewContext.crewName !== '') return dynamicCrewContext.crewName
  return crewContext?.crewName
}

let leadCrewFallback: string | null = null

export function setLeadCrewFallback(crewName: string | null): void {
  leadCrewFallback = crewName
}

export function getLeadCrewFallback(): string | null {
  return leadCrewFallback
}

export function resolveLeadAwareCrewName(crewContext?: { crewName: string }): string | undefined {
  return getCrewName(crewContext) ?? leadCrewFallback ?? undefined
}

export function isCrewmate(): boolean {
  if (getCrewmateContext() !== undefined) return true
  return (
    dynamicCrewContext !== null &&
    dynamicCrewContext.agentId !== '' &&
    dynamicCrewContext.crewName !== ''
  )
}


export function isCrewLead(crewContext: { leadAgentId: string } | undefined): boolean {
  if (!crewContext?.leadAgentId) return false
  const agentId = getAgentId()
  if (agentId === undefined) return true
  return agentId === crewContext.leadAgentId
}

export function hasActiveInProcessCrewmates(appState: AppState): boolean {
  return Object.values(appState.tasks).some(
    task => isInProcessCrewmateTask(task) && task.status === 'running',
  )
}

export function hasWorkingInProcessCrewmates(appState: AppState): boolean {
  return Object.values(appState.tasks).some(
    task => isInProcessCrewmateTask(task) && task.status === 'running' && !task.isIdle,
  )
}

export function waitForCrewmatesToBecomeIdle(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  appState: AppState,
): Promise<void> {
  const waitingIds = Object.entries(appState.tasks)
    .filter(([, task]) => isInProcessCrewmateTask(task) && task.status === 'running' && !task.isIdle)
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
        if (!isInProcessCrewmateTask(task)) continue
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
