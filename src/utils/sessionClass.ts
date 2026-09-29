import type { LogOption } from '../types/logs.js'

export type SessionClass = 'operator' | 'crew'

const BRIDGE_FIRST_PROMPT =
  /^(\[control (ack|pause|resume|stop|clear)\]|\[progress |\[escalate\]|\[operator note\]|\[operator broadcast\])/
const FRAMED_DISPATCH_HEAD =
  'Dispatched work, relayed over the bus with the dispatcher'

export function isCrewSession(log: LogOption): boolean {
  if (log.isCrewmate) return true
  if (log.crewName && log.crewName.trim() !== '') return true
  const fp = (log.firstPrompt ?? '').trim()
  if (fp.includes(FRAMED_DISPATCH_HEAD)) return true
  return BRIDGE_FIRST_PROMPT.test(fp)
}

export function crewTagOf(log: LogOption): string {
  const crew = (log.crewName ?? '').trim()
  const agent = (log.agentName ?? '').trim()
  if (crew && agent) return `${crew} · ${agent}`
  if (crew) return crew
  if (agent) return agent
  return 'crew'
}
