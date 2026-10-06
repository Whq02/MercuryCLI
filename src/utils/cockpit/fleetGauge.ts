import { listConcourseWorkers } from '../../daemon/concourseWorkers.js'
import { listExecutions } from '../../services/primitives/executionPlane.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { withState, type Snapshot } from './types.js'

export type FleetRosterSource = 'concourse' | 'execution'

export interface FleetRosterEntry {
  id: string
  name: string
  source: FleetRosterSource
  state: string
  model?: string
  detail?: string
}

export type FleetData = {
  roster: FleetRosterEntry[]
}

const CONCOURSE_STALE_MS = 60_000

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

function rosterRows(nowMs: number): FleetRosterEntry[] {
  return [...concourseRows(nowMs), ...executionRows()]
}

export async function fleetGauge(): Promise<Snapshot<{ data: FleetData }>> {
  const roster = rosterRows(Date.now())
  return withState('off', { roster }, 'no fleet', 'fleet roster')
}
