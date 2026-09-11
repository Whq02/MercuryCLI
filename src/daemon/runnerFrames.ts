
export const TURN_STARTED_SUBTYPE = 'turn_started'

export type TurnStartedFrame = {
  type: 'system'
  subtype: typeof TURN_STARTED_SUBTYPE
  uuids: string[]
  uuid: string
  session_id: string
}

export function turnStartedFrame(sessionId: string, uuids: readonly string[], uuid: string): TurnStartedFrame {
  return { type: 'system', subtype: TURN_STARTED_SUBTYPE, uuids: [...uuids], uuid, session_id: sessionId }
}

export function isTurnStartedParsedFrame(frame: Record<string, unknown> | null): boolean {
  return frame !== null && frame.type === 'system' && frame.subtype === TURN_STARTED_SUBTYPE
}

export const MISSION_UPDATED_SUBTYPE = 'mission_updated'

export type MissionUpdatedFrame = {
  type: 'system'
  subtype: typeof MISSION_UPDATED_SUBTYPE
  uuid: string
  session_id: string
}

export function missionUpdatedFrame(sessionId: string, uuid: string): MissionUpdatedFrame {
  return { type: 'system', subtype: MISSION_UPDATED_SUBTYPE, uuid, session_id: sessionId }
}

export function isMissionUpdatedParsedFrame(frame: Record<string, unknown> | null): boolean {
  return frame !== null && frame.type === 'system' && frame.subtype === MISSION_UPDATED_SUBTYPE
}

export const SAMPLES_UPDATED_SUBTYPE = 'samples_updated'

export type SamplesUpdatedFrame = {
  type: 'system'
  subtype: typeof SAMPLES_UPDATED_SUBTYPE
  uuid: string
  session_id: string
}

export function samplesUpdatedFrame(sessionId: string, uuid: string): SamplesUpdatedFrame {
  return { type: 'system', subtype: SAMPLES_UPDATED_SUBTYPE, uuid, session_id: sessionId }
}

export function isSamplesUpdatedParsedFrame(frame: Record<string, unknown> | null): boolean {
  return frame !== null && frame.type === 'system' && frame.subtype === SAMPLES_UPDATED_SUBTYPE
}
