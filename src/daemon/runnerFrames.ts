
export const SEAT_VERB_APPLIED_SUBTYPE = 'seat_verb_applied'

export type SeatVerbAppliedFrame = {
  type: 'system'
  subtype: typeof SEAT_VERB_APPLIED_SUBTYPE
  request_id: string
  verb: 'set_model' | 'set_effort' | 'spawn_switch'
  model?: string
  effort?: string
  switch?: 'subagents' | 'workflows'
  on?: boolean
  uuid: string
  session_id: string
}

export type SeatVerbLanded =
  | { verb: 'set_model'; model: string }
  | { verb: 'set_effort'; effort: string }
  | { verb: 'spawn_switch'; switch: 'subagents' | 'workflows'; on: boolean }

export function seatVerbAppliedFrame(sessionId: string, requestId: string, landed: SeatVerbLanded, uuid: string): SeatVerbAppliedFrame {
  return { type: 'system', subtype: SEAT_VERB_APPLIED_SUBTYPE, request_id: requestId, ...landed, uuid, session_id: sessionId }
}

export function isSeatVerbAppliedParsedFrame(frame: Record<string, unknown> | null): boolean {
  return frame !== null && frame.type === 'system' && frame.subtype === SEAT_VERB_APPLIED_SUBTYPE && typeof frame.request_id === 'string' && (frame.verb === 'set_model' || frame.verb === 'set_effort' || frame.verb === 'spawn_switch')
}
