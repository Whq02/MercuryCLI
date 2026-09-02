/**
 * ITEM 17 — Room-commander derived health + tree-conflict detection.
 *
 * A READ-ONLY derivation (no writes, no spawn) that, for the current team,
 * folds existing signals into:
 *   1. Per-agent health — idle vs busy (from the roster's task ownership) plus
 *      a staleness flag derived from lease age (a busy agent whose only lease
 *      has gone stale past a drift window is "drifting").
 *   2. Cross-agent TREE CONFLICTS — two agents whose leased globs OVERLAP (via
 *      the SAME globsOverlap the lease guard enforces, so this view can never
 *      disagree with enforcement), surfaced before an edit ever clashes.
 *
 * deriveRoomTrack + detectTreeConflicts over Mercury's data
 * sources (getAgentStatuses + listLeases).
 *
 * DEFENSIVE / DEFAULT-NO-OP: no team / no roster / no leases ⇒ empty result,
 * never a crash. Pure derivation given its injected inputs; the gather helper
 * fails open (returns an empty health snapshot) on any read error.
 */

import { getAgentStatuses, type AgentStatus } from '../tasks.js'
import { globsOverlap, isLeaseExpired, type Lease, listLeases } from './leaseGlob.js'
import { logForDebugging } from '../debug.js'

/** A busy agent whose newest lease is older than this counts as drifting. */
export const DEFAULT_DRIFT_WINDOW_MS = 45 * 60 * 1000 // 45 minutes

/** Per-agent health verdict. */
export type AgentHealth = {
  name: string
  agentType?: string
  /** idle (owns no open tasks), busy (owns ≥1 open task and a fresh signal), or
   *  drifting (busy but its leases have gone stale past the drift window). */
  state: 'idle' | 'busy' | 'drifting'
  /** Open task IDs the agent owns (from the roster). */
  currentTasks: string[]
  /** Age in ms of the agent's freshest lease, or null if it holds none. */
  leaseAgeMs: number | null
  /** One-line reason for the state. */
  why: string
}

/** A cross-agent tree conflict — two agents' leases overlap. */
export type TreeConflict = {
  kind: 'lease-overlap'
  /** The two agent ids, sorted. */
  agents: [string, string]
  /** Human-readable detail of the clashing globs. */
  detail: string
}

/** The full derived snapshot surfaced by TeamBrief. */
export type RoomHealthSnapshot = {
  agents: AgentHealth[]
  conflicts: TreeConflict[]
}

/** Freshest (smallest) lease age in ms for an agent, or null if it holds none. */
function freshestLeaseAgeMs(
  agentId: string,
  agentName: string,
  leases: Lease[],
  nowMs: number,
): number | null {
  let best: number | null = null
  for (const lease of leases) {
    // Leases are keyed by agentId (a stable id or agent type). Match either the
    // roster agentId or the display name so both lease-keying conventions work.
    if (lease.agentId !== agentId && lease.agentId !== agentName) continue
    const t = Date.parse(lease.ts)
    if (!Number.isFinite(t)) continue
    const age = nowMs - t
    if (best === null || age < best) best = age
  }
  return best
}

/**
 * Compute per-agent health. PURE given its inputs (roster + live leases + clock).
 *   - idle: owns no open tasks.
 *   - busy: owns ≥1 open task (and either holds a fresh lease or none — having
 *     no lease isn't itself stale; the task ownership is the signal).
 *   - drifting: busy AND holds at least one lease whose FRESHEST is older than
 *     the drift window (claimed work but the lease hasn't been refreshed —
 *     a stall signal, mirroring deriveRoomTrack's "drifting").
 */
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

    // Busy + holds a lease that's gone stale past the drift window ⇒ drifting.
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

/**
 * Cross-agent tree-conflict detection: two DIFFERENT agents whose (non-expired)
 * leased globs overlap — the SAME broad globsOverlap the lease conflict check
 * uses, so this view can never disagree with enforcement. PURE given inputs.
 * Dedups to one finding per agent-pair. Empty leases ⇒ no conflicts.
 */
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

/**
 * Gather the room-health snapshot for a team. READ-ONLY and fails open: any
 * read error / no team / no leases ⇒ an empty snapshot, never a throw. Used by
 * TeamBrief.
 */
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
