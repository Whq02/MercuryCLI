
import { getTeamName } from './teammate.js'
import {
  computeAgentHealth,
  type AgentHealth,
} from './swarm/roomHealth.js'
import { listLeases, type Lease } from './swarm/leaseGlob.js'
import { getAgentStatuses, type AgentStatus } from './tasks.js'

export const SESSION_POLL_MS = 2000
export const WORKFLOW_POLL_MS = 5000

export interface LiveCounts {
  liveSessions: number
  sessionCount: number
  runningWorkflows: number
  bridgeConnected: boolean
}

export const EMPTY_COUNTS: LiveCounts = {
  liveSessions: 0,
  sessionCount: 0,
  runningWorkflows: 0,
  bridgeConnected: false,
}


export interface ScopedSessionRow {
  accountUuid?: string
}

export interface AccountScopeInputs {
  activeId: string
  sessionAccount: ReadonlyMap<string, string>
  activeUuid?: string
}

export function sessionPositivelyForeign(
  sid: string,
  s: ScopedSessionRow | undefined,
  inp: AccountScopeInputs,
): boolean {
  const mapped = inp.sessionAccount.get(sid)
  if (mapped !== undefined) return mapped !== inp.activeId
  return !!inp.activeUuid && !!s?.accountUuid && s.accountUuid !== inp.activeUuid
}


export function countRunningWorkflows(health: readonly AgentHealth[]): number {
  return health.filter(a => a.state === 'busy' || a.state === 'drifting').length
}


export async function readLiveSessions(): Promise<{ liveSessions: number; sessionCount: number }> {
  try {
    const { countLiveConcourseWorkers } = await import('../daemon/concourseSupervisor.js')
    const n = 1 + countLiveConcourseWorkers()
    return { liveSessions: n, sessionCount: n }
  } catch {
    return { liveSessions: 1, sessionCount: 1 }
  }
}

export async function readRunningWorkflows(): Promise<{ runningWorkflows: number; bridgeConnected: boolean }> {
  const teamName = getTeamName() ?? null
  if (!teamName) return { runningWorkflows: 0, bridgeConnected: false }
  try {
    const nowMs = Date.now()
    const [statuses, leases] = await Promise.all([
      getAgentStatuses(teamName).catch(() => null as AgentStatus[] | null),
      listLeases(teamName, { nowMs }).catch(() => [] as Lease[]),
    ])
    const health = computeAgentHealth(statuses ?? [], leases, { nowMs })
    return { runningWorkflows: countRunningWorkflows(health), bridgeConnected: true }
  } catch {
    return { runningWorkflows: 0, bridgeConnected: false }
  }
}
