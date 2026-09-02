import type { AppState } from '../state/AppStateStore.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { TEAM_LEAD_NAME } from './swarm/constants.js'
import { getTeammateContext } from './teammateContext.js'

/**
 * This session's swarm identity (agent/team/lead) and teammate-idle
 * waiting. Resolution order for every accessor: the async-scoped
 * in-process teammate context, then the dynamic team context, then (for
 * the team name only) a caller-supplied team context from application
 * state.
 */

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

// Set when a session joins a team at runtime (e.g. CLI identity arguments).
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

/** In-process context wins for every accessor — even when its own field is absent. */
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

/**
 * The ONE coordination identity, shared by lease claim and lease guard: a
 * leader claims and is checked under the same name and cannot collide with
 * its own lease.
 */
export function resolveCoordAgentId(): string {
  return getAgentName() ?? TEAM_LEAD_NAME
}

/**
 * A lead session has neither an in-process nor a dynamic context, so a
 * BARE call answers nothing for a lead even while the on-disk roster
 * exists — lead-seat consumers pass the application-state context or opt
 * into the lead-aware resolver.
 */
export function getTeamName(teamContext?: { teamName: string }): string | undefined {
  const context = getTeammateContext()
  if (context) return context.teamName
  if (dynamicTeamContext && dynamicTeamContext.teamName !== '') return dynamicTeamContext.teamName
  return teamContext?.teamName
}

// Registered by lead-side engage/disengage seams. Deliberately NOT a rung
// inside the ordinary team-name resolution: adding it there would flip the
// is-teammate predicate for a lead session. Only lead-aware surfaces opt
// in through the resolver below.
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

/** The dynamic path requires BOTH a non-empty agent id and a non-empty team name. */
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

/**
 * True for the lead agent id, or when we have no agent id at all — the
 * backwards-compatibility arm for the original session that created the
 * team before agent ids were standardised.
 */
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

/**
 * Resolves when every currently running, non-idle in-process teammate has
 * reported idle. Registration happens inside one state update over a
 * copied task map, and each task's CURRENT state is re-checked at
 * registration: a task that went idle between the snapshot and the update
 * counts immediately instead of waiting on a callback that would never
 * fire. A task that vanished in that window leaves the promise pending —
 * deliberately; do not add a timeout here without its own decision.
 */
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
