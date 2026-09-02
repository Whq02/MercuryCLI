// ============================================================================
//  fleetGauge — the ONE owner of "who is working right now".
//
//  Two facets, each read from its owner:
//    · the TEAM facet — the coordination substrate for the current team:
//      tasks, agent health (roomHealth's one derivation), leases and
//      tree-conflicts. `off` (not a crash) when not in a team — /fleet is a
//      swarm surface, so no team is a valid dormant state. No fake live
//      agents.
//    · the ROSTER — every running agent this process can see, whatever
//      substrate runs it: team members (the health rows), the daemon crew
//      (/teammates' named workers), concourse workers, and the execution
//      plane's live agent executions. The roster rides EVERY arm (off
//      included): a solo session with a standing crew still lists it. Each
//      row names its source so a consumer can say where the agent lives.
//
//  Every read is fail-soft per source: one substrate's read failing empties
//  its rows, never the gauge. The telemetry bus re-reads this gauge on its
//  event edges (transcript · tasks · execution-plane events · heartbeat), so
//  the roster is live without a poll of its own.
// ============================================================================

import { listConcourseWorkers } from '../../daemon/concourseSupervisor.js'
import { listExecutions } from '../../services/primitives/executionPlane.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { crewEnabled } from '../../daemon/crewSpawn.js'
import { crewRosterStatus, listCrewMembers } from '../crew/crewClient.js'
import type { Task } from '../tasks.js'
import { getAgentStatuses, listTasks } from '../tasks.js'
import {
  computeAgentHealth,
  detectTreeConflicts,
  type AgentHealth,
  type TreeConflict,
} from '../swarm/roomHealth.js'
import { listLeases, type Lease } from '../swarm/leaseGlob.js'
import { getTeamName } from '../teammate.js'
import { withState, type Snapshot } from './types.js'

/** Where a roster row's agent lives. */
export type FleetRosterSource = 'team' | 'crew' | 'concourse' | 'execution'

export interface FleetRosterEntry {
  /** Stable per source (`crew:<name>`, `execution:<id>`). */
  id: string
  name: string
  source: FleetRosterSource
  /** The source's own state word (idle · busy · drifting · spawning · online …). */
  state: string
  /** The model the agent runs, when the source records it. */
  model?: string
  /** One line of the source's own detail (the health `why`, a task label). */
  detail?: string
}

export type FleetData = {
  teamName: string | null
  tasks: Task[]
  health: AgentHealth[]
  leases: Lease[]
  conflicts: TreeConflict[]
  /** Every running agent across substrates — present on every arm. */
  roster: FleetRosterEntry[]
}

/** A concourse worker with no liveness signal for this long reads `stale`. */
const CONCOURSE_STALE_MS = 60_000

const empty = (teamName: string | null, roster: FleetRosterEntry[]): FleetData => ({
  teamName,
  tasks: [],
  health: [],
  leases: [],
  conflicts: [],
  roster,
})

async function crewRows(): Promise<FleetRosterEntry[]> {
  try {
    if (!crewEnabled()) return []
    const members = await listCrewMembers()
    if (members.length === 0) return []
    const status = await crewRosterStatus(members.map(m => m.name))
    return members.map(m => ({
      id: `crew:${m.name}`,
      name: m.name,
      source: 'crew' as const,
      state: status.has(m.name) ? 'online' : 'offline',
      ...(m.model !== undefined ? { model: m.model } : {}),
    }))
  } catch {
    return []
  }
}

function concourseRows(nowMs: number): FleetRosterEntry[] {
  try {
    return listConcourseWorkers(null).map(r => ({
      id: `concourse:${r.runnerId}`,
      name: r.agentName ?? r.runnerId,
      source: 'concourse' as const,
      state: r.pausedAt !== undefined ? 'paused' : nowMs - r.lastLiveAt > CONCOURSE_STALE_MS ? 'stale' : 'running',
      model: r.modelKey,
    }))
  } catch {
    return []
  }
}

function executionRows(): FleetRosterEntry[] {
  try {
    return listExecutions(processMainOwner(), { liveOnly: true, kind: 'agent' }).map(r => ({
      id: `execution:${r.spec.id}`,
      name: r.spec.label,
      source: 'execution' as const,
      state: r.state,
    }))
  } catch {
    return []
  }
}

function teamRows(health: AgentHealth[]): FleetRosterEntry[] {
  return health.map(h => ({
    id: `team:${h.name}`,
    name: h.name,
    source: 'team' as const,
    state: h.state,
    detail: h.why,
  }))
}

async function rosterRows(nowMs: number, health: AgentHealth[]): Promise<FleetRosterEntry[]> {
  const crew = await crewRows()
  return [...teamRows(health), ...crew, ...concourseRows(nowMs), ...executionRows()]
}

export async function fleetGauge(): Promise<Snapshot<{ data: FleetData }>> {
  const nowMs = Date.now()
  const teamName = getTeamName() ?? null
  if (!teamName) {
    const roster = await rosterRows(nowMs, [])
    return withState('off', empty(null, roster), 'not in a team — /fleet is a swarm surface', 'getTeamName')
  }
  try {
    const [tasks, statuses, leases] = await Promise.all([
      listTasks(teamName).catch(() => [] as Task[]),
      getAgentStatuses(teamName).catch(() => null),
      listLeases(teamName, { nowMs }).catch(() => [] as Lease[]),
    ])
    const health = computeAgentHealth(statuses ?? [], leases, { nowMs })
    const roster = await rosterRows(nowMs, health)
    return {
      state: 'live',
      source: 'roomHealth ⊕ crew · concourse · execution plane',
      data: {
        teamName,
        tasks: tasks.filter(t => !t.metadata?._internal),
        health,
        leases,
        conflicts: detectTreeConflicts(leases, { nowMs }),
        roster,
      },
    }
  } catch {
    const roster = await rosterRows(nowMs, []).catch(() => [] as FleetRosterEntry[])
    return withState('failed', empty(teamName, roster), 'fleet read failed')
  }
}
