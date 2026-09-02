
import { listAttachedSeats } from './seatBridge.js'
import { resolveCrewSnapshot, type CrewMemberV1, type CrewSnapshotV1 } from './projection.js'
import type { CrewAgentId } from './identity.js'

export interface TargetPickerRow {
  agentId: CrewAgentId
  label: string
  presence: CrewMemberV1['presence']
  lifecycle?: CrewMemberV1['lifecycle']
  endpoint: 'seat' | 'local-queue' | 'none'
  dispatchable: boolean
  seatId?: string
}

export function targetPickerRows(snapshot: CrewSnapshotV1 | null): TargetPickerRow[] {
  if (!snapshot) return []
  const seatByAgent = new Map(listAttachedSeats().map(s => [s.agentId as string, s]))
  return snapshot.members.map(m => {
    const seat = seatByAgent.get(m.agentId as string)
    const isMain = m.presence.source === 'session'
    const endpoint: TargetPickerRow['endpoint'] = seat
      ? 'seat'
      : isMain
        ? 'local-queue'
        : 'none'
    return {
      agentId: m.agentId,
      label: m.label,
      presence: m.presence,
      ...(m.lifecycle !== undefined ? { lifecycle: m.lifecycle } : {}),
      endpoint,
      dispatchable: endpoint !== 'none',
      ...(seat !== undefined ? { seatId: seat.seatId } : {}),
    }
  })
}

export function dispatchableTargets(snapshot: CrewSnapshotV1 | null): TargetPickerRow[] {
  return targetPickerRows(snapshot).filter(r => r.dispatchable)
}
