import { logForDebugging } from '../../platform/logs/debugLog.js'
import { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import { sessionKitToWire } from '../../engine/connector/seatWire.js'
import { updateConcourseWorkers } from '../concourse-workers/concourseWorkers.js'
import { PeerClosed } from '../runner-wire/peer.js'
import type { SessionKitEditV1 } from './sessionKit.js'
import { applyConcourseKitOp } from './sessionKitOp.js'
import { liveRecordBySession, seatBusy, type SeatRosterPort, liveRecordByShort } from './state.js'
import { publishSeatFacts, requestSessionFacts } from './facts.js'
import type { SeatVerbOutcome } from './door.js'

export const KIT_DIAL_QUEUED_DETAIL = 'the dials apply when this turn ends'

export function setSessionKitDial(
  sessionId: string,
  edit: SessionKitEditV1,
  by: string,
  roster: SeatRosterPort,
  dir?: string,
): SeatVerbOutcome {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (seatBusy(rec.runnerId, roster)) {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (w && w.endedAt === undefined) w.pendingKitEdits = [...(w.pendingKitEdits ?? []), { edit, by }]
    }, dir)
    console.error(`[daemon] seat ${SESSION_VERBS.setKit.daemon.action} parked (the session is mid-turn): ${rec.runnerId}`)
    publishSeatFacts(rec.runnerId, dir, roster)
    return { outcome: 'queued', detail: KIT_DIAL_QUEUED_DETAIL }
  }
  const out = applyConcourseKitOp(sessionId, edit, by, dir)
  if (out.outcome !== 'applied') return out
  const forwarded = forwardSessionKit(rec.runnerId, roster, dir)
  publishSeatFacts(rec.runnerId, dir, roster)
  requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  return forwarded
    ? { outcome: 'applied', ...(out.detail !== undefined ? { detail: out.detail } : {}) }
    : {
        outcome: 'applied',
        detail: `${out.detail ?? 'applied'} — no live runner door; the record holds the kit and the session's next boot applies it`,
      }
}

function forwardSessionKit(short: string, roster: SeatRosterPort, dir?: string): boolean {
  const rec = liveRecordByShort(short, dir)
  if (!rec || rec.kit === undefined) return false
  const door = roster.door(short)
  if (door === undefined || door.closed) return false
  door.request(SESSION_VERBS.setKit.runner.name, { kit: sessionKitToWire(rec.kit) }).then(
    () => requestSessionFacts(short, roster, { immediate: true }, dir),
    (error: unknown) => {
      if (!(error instanceof PeerClosed)) logForDebugging(`[daemon] seat ${SESSION_VERBS.setKit.daemon.action} for ${short}: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
  return true
}

export function drainPendingKitDials(short: string, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const parked = rec.pendingKitEdits ?? []
  if (parked.length === 0) return
  updateConcourseWorkers(workers => {
    const w = workers[short]
    if (w && w.endedAt === undefined) delete w.pendingKitEdits
  }, dir)
  console.error(`[daemon] seat ${SESSION_VERBS.setKit.daemon.action} applying ${parked.length} parked dial${parked.length === 1 ? '' : 's'} at the turn's end: ${short}`)
  for (const entry of parked) applyConcourseKitOp(rec.sessionId, entry.edit, entry.by, dir)
  forwardSessionKit(short, roster, dir)
}
