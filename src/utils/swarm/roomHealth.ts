
import { getAgentStatuses, type AgentStatus } from '../tasks.js'
import { globsOverlap, isLeaseExpired, type Lease, listLeases } from './leaseGlob.js'
import { logForDebugging } from '../debug.js'

export const DEFAULT_DRIFT_WINDOW_MS = 45 * 60 * 1000

export type AgentHealth = {
  name: string
  agentType?: string
  state: 'idle' | 'busy' | 'drifting'
  currentTasks: string[]
  leaseAgeMs: number | null
  why: string
}

export type TreeConflict = {
  kind: 'lease-overlap'
  agents: [string, string]
  detail: string
}

export type RoomHealthSnapshot = {
  agents: AgentHealth[]
  conflicts: TreeConflict[]
}

function freshestLeaseAgeMs(
  agentId: string,
  agentName: string,
  leases: Lease[],
  nowMs: number,
): number | null {
  let best: number | null = null
  for (const lease of leases) {
    if (lease.agentId !== agentId && lease.agentId !== agentName) continue
    const t = Date.parse(lease.ts)
    if (!Number.isFinite(t)) continue
    const age = nowMs - t
    if (best === null || age < best) best = age
  }
  return best
}

export function computeAgentHealth(
  roster: AgentStatus[],
  leases: Lease[],
  opts: { nowMs?: number; driftWindowMs?: number } = {},
): AgentHealth[] {
  const nowMs = opts.nowMs ?? Date.now()
  const windowMs =
    typeof opts.driftWindowMs === 'number' && opts.driftWindowMs > 0
      ? opts.driftWindowMs
      : DEFAULT_DRIFT_WINDOW_MS

  return roster.map(member => {
    const leaseAgeMs = freshestLeaseAgeMs(
      member.agentId,
      member.name,
      leases,
      nowMs,
    )
    const busy = member.status === 'busy'

    if (!busy) {
      return {
        name: member.name,
        agentType: member.agentType,
        state: 'idle' as const,
        currentTasks: member.currentTasks,
        leaseAgeMs,
        why: 'no open tasks owned',
      }
    }

    if (leaseAgeMs !== null && leaseAgeMs > windowMs) {
      return {
        name: member.name,
        agentType: member.agentType,
        state: 'drifting' as const,
        currentTasks: member.currentTasks,
        leaseAgeMs,
        why: `busy on ${member.currentTasks.length} task(s) but its lease has not refreshed in ${Math.round(
          leaseAgeMs / 60000,
        )}m`,
      }
    }

    return {
      name: member.name,
      agentType: member.agentType,
      state: 'busy' as const,
      currentTasks: member.currentTasks,
      leaseAgeMs,
      why: `busy on ${member.currentTasks.length} task(s)`,
    }
  })
}

export function detectTreeConflicts(
  leases: Lease[],
  opts: { nowMs?: number } = {},
): TreeConflict[] {
  const nowMs = opts.nowMs ?? Date.now()
  const live = leases.filter(
    l =>
      !!l &&
      typeof l.agentId === 'string' &&
      Array.isArray(l.globs) &&
      !isLeaseExpired(l, nowMs),
  )

  const conflicts: TreeConflict[] = []
  const seen = new Set<string>()
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      if (live[a]!.agentId === live[b]!.agentId) continue
      for (const ga of live[a]!.globs) {
        for (const gb of live[b]!.globs) {
          if (typeof ga !== 'string' || typeof gb !== 'string') continue
          if (globsOverlap(ga, gb)) {
            const agents = [live[a]!.agentId, live[b]!.agentId].sort() as [
              string,
              string,
            ]
            const key = agents.join('+')
            if (seen.has(key)) continue
            seen.add(key)
            conflicts.push({
              kind: 'lease-overlap',
              agents,
              detail: `${live[a]!.agentId} (${ga}) overlaps ${live[b]!.agentId} (${gb})`,
            })
          }
        }
      }
    }
  }
  return conflicts
}

export async function getRoomHealth(
  teamName: string | null | undefined,
  opts: { nowMs?: number; driftWindowMs?: number } = {},
): Promise<RoomHealthSnapshot> {
  if (!teamName) return { agents: [], conflicts: [] }
  try {
    const nowMs = opts.nowMs ?? Date.now()
    const [statuses, leases] = await Promise.all([
      getAgentStatuses(teamName),
      listLeases(teamName, { nowMs }),
    ])
    const roster = statuses ?? []
    return {
      agents: computeAgentHealth(roster, leases, {
        nowMs,
        driftWindowMs: opts.driftWindowMs,
      }),
      conflicts: detectTreeConflicts(leases, { nowMs }),
    }
  } catch (error) {
    logForDebugging(`[RoomHealth] getRoomHealth failed (returning empty): ${error}`)
    return { agents: [], conflicts: [] }
  }
}
