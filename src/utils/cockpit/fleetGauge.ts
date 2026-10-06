
import { listConcourseWorkers } from '../../daemon/concourseWorkers.js'
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
} from '../crew/roomHealth.js'
import { listLeases, type Lease } from '../crew/leaseGlob.js'
import { getCrewName } from '../crewmate.js'
import { withState, type Snapshot } from './types.js'

export type FleetRosterSource = 'crew' | 'crew' | 'concourse' | 'execution'

export interface FleetRosterEntry {
  id: string
  name: string
  source: FleetRosterSource
  state: string
  model?: string
  detail?: string
}

export type FleetData = {
  crewName: string | null
  tasks: Task[]
  health: AgentHealth[]
  leases: Lease[]
  conflicts: TreeConflict[]
  roster: FleetRosterEntry[]
}

const CONCOURSE_STALE_MS = 60_000

const empty = (crewName: string | null, roster: FleetRosterEntry[]): FleetData => ({
  crewName,
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

function savedRows(health: AgentHealth[]): FleetRosterEntry[] {
  return health.map(h => ({
    id: `crew:${h.name}`,
    name: h.name,
    source: 'crew' as const,
    state: h.state,
    detail: h.why,
  }))
}

async function rosterRows(nowMs: number, health: AgentHealth[]): Promise<FleetRosterEntry[]> {
  const crew = await crewRows()
  return [...savedRows(health), ...crew, ...concourseRows(nowMs), ...executionRows()]
}

export async function fleetGauge(): Promise<Snapshot<{ data: FleetData }>> {
  const nowMs = Date.now()
  const crewName = getCrewName() ?? null
  if (!crewName) {
    const roster = await rosterRows(nowMs, [])
    return withState('off', empty(null, roster), 'not in an agent group', 'getCrewName')
  }
  try {
    const [tasks, statuses, leases] = await Promise.all([
      listTasks(crewName).catch(() => [] as Task[]),
      getAgentStatuses(crewName).catch(() => null),
      listLeases(crewName, { nowMs }).catch(() => [] as Lease[]),
    ])
    const health = computeAgentHealth(statuses ?? [], leases, { nowMs })
    const roster = await rosterRows(nowMs, health)
    return {
      state: 'live',
      source: 'roomHealth ⊕ crew · concourse · execution plane',
      data: {
        crewName,
        tasks: tasks.filter(t => !t.metadata?._internal),
        health,
        leases,
        conflicts: detectTreeConflicts(leases, { nowMs }),
        roster,
      },
    }
  } catch {
    const roster = await rosterRows(nowMs, []).catch(() => [] as FleetRosterEntry[])
    return withState('failed', empty(crewName, roster), 'fleet read failed')
  }
}
