import { listConcourseWorkers } from '../../daemon/concourse-workers/concourseWorkers.js'
import { listExecutions } from '../../engine/execution-plane/executionPlane.js'
import { processMainOwner } from '../../engine/run-owner/resolveOwner.js'
import { withState, type Snapshot } from '../cockpit/types.js'
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
  return listConcourseWorkers(null).map(r => ({
    id: `concourse:${r.runnerId}`,
    name: r.agentName ?? r.runnerId,
    source: 'concourse' as const,
    state: r.pausedAt !== undefined ? 'paused' : nowMs - r.lastLiveAt > CONCOURSE_STALE_MS ? 'stale' : 'running',
    model: r.modelKey,
  }))
}

function executionRows(): FleetRosterEntry[] {
  return listExecutions(processMainOwner(), { liveOnly: true, kind: 'agent' }).map(r => ({
    id: `execution:${r.spec.id}`,
    name: r.spec.label,
    source: 'execution' as const,
    state: r.state,
  }))
}

export async function fleetGauge(): Promise<Snapshot<{ data: FleetData }>> {
  const nowMs = Date.now()
  let concourse: FleetRosterEntry[] = []
  let executions: FleetRosterEntry[] = []
  let firstError: unknown = null
  try {
    concourse = concourseRows(nowMs)
  } catch (error) {
    firstError ??= error
  }
  try {
    executions = executionRows()
  } catch (error) {
    firstError ??= error
  }
  const roster = [...concourse, ...executions]
  if (firstError !== null) {
    const detail = firstError instanceof Error ? firstError.message : String(firstError)
    return withState('unavailable', { roster }, `fleet roster unreadable (${detail})`, 'fleet roster')
  }
  return withState('off', { roster }, 'no fleet', 'fleet roster')
}
