import type { LogOption } from '../types/logs.js'

export type SessionClass = 'operator' | 'crew'

const LANE_PATH = /[\\/]\.mercury[\\/]party[\\/]lanes[\\/]|[\\/]party_dps\d/
const BRIDGE_FIRST_PROMPT =
  /^(\[control (ack|pause|resume|stop|clear)\]|\[progress |\[escalate\]|\[operator note\]|\[operator broadcast\])/
const FRAMED_DISPATCH_HEAD =
  'Dispatched work, relayed over the bus with the dispatcher'

export function isCrewSession(log: LogOption): boolean {
  if (log.isTeammate) return true
  if (log.teamName && log.teamName.trim() !== '') return true
  const p = (log as { projectPath?: string }).projectPath ?? log.fullPath ?? ''
  if (LANE_PATH.test(p)) return true
  const fp = (log.firstPrompt ?? '').trim()
  if (fp.includes(FRAMED_DISPATCH_HEAD)) return true
  return BRIDGE_FIRST_PROMPT.test(fp)
}

export function crewTagOf(log: LogOption): string {
  const team = (log.teamName ?? '').trim()
  const agent = (log.agentName ?? '').trim()
  if (team && agent) return `${team} · ${agent}`
  if (team) return team
  if (agent) return agent
  const p = (log as { projectPath?: string }).projectPath ?? log.fullPath ?? ''
  const lane = /party_(dps\d|tank|healer)/.exec(p)?.[1]
  return lane ? `party · ${lane}` : 'crew'
}
