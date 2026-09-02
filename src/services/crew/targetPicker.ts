// ============================================================================
//  crew/targetPicker — the ONE teammate target-picker model (
//  M6; the "feeds every surface" leg for Console/Minerva/cockpit).
//
//  Every surface that lets the operator choose a teammate (the board's
//  dispatch composer, Minerva's destination select, the Console handoff)
//  derives its rows HERE — from the crew projection (`useCrew`/
//  `cachedCrewSnapshot`) joined with the live seat bridge — so "select any
//  teammate by stable identity" is one behavior, not three:
//    · rows key on CrewAgentId (display text NEVER routes);
//    · `dispatchable` is derived from REAL endpoints (an attached seat, or
//      the main agent's local queue) — a surface may show the full directory
//      but must not advertise a send that is a guaranteed refusal;
//    · presence/lifecycle ride along verbatim (source-backed facts, never
//      re-derived).
// ============================================================================

import { listAttachedSeats } from './seatBridge.js'
import { resolveCrewSnapshot, type CrewMemberV1, type CrewSnapshotV1 } from './projection.js'
import type { CrewAgentId } from './identity.js'

export interface TargetPickerRow {
  agentId: CrewAgentId
  /** Collision-safe presentation label (displayLabelsOf) — eyes only. */
  label: string
  presence: CrewMemberV1['presence']
  lifecycle?: CrewMemberV1['lifecycle']
  /** The REAL endpoint behind a send, when one exists. */
  endpoint: 'seat' | 'local-queue' | 'none'
  /** True only when a dispatch can actually be taken. */
  dispatchable: boolean
  /** The seat id when the endpoint is an attached seat. */
  seatId?: string
}

/**
 * Derive the picker rows from a crew snapshot. Pure given its inputs; the
 * seat roster is read at call time (process-scoped live state).
 */
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

/** The dispatchable subset — what a composer's target cycle advertises. */
export function dispatchableTargets(snapshot: CrewSnapshotV1 | null): TargetPickerRow[] {
  return targetPickerRows(snapshot).filter(r => r.dispatchable)
}

