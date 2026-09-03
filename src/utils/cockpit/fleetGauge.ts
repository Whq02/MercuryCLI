
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

export type FleetRosterSource = 'team' | 'crew' | 'concourse' | 'execution'

export interface FleetRosterEntry {
  id: string
  name: string
  source: FleetRosterSource
  state: string
  model?: string
  detail?: string
}

export type FleetData = {
  teamName: string | null
  tasks: Task[]
  health: AgentHealth[]
  leases: Lease[]
  conflicts: TreeConflict[]
  roster: FleetRosterEntry[]
}

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
    return withState('off', empty(null, roster), 'not in an agent group — /fleet reads a shared group', 'getTeamName')
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
