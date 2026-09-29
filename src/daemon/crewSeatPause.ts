import { AGENT_WINDOW_RESUME_NOTE, CREW_ACCOUNT_RESUME_NOTE, pauseClockWords, pauseLineWords, type AgentPauseV1 } from '../tasks/LocalAgentTask/agentPause.js'
import { errorTextOfParsedResultFrame, isTurnResultParsedFrame } from './longLivedSupervisor.js'

export type CrewSeatWindow = { rejected: boolean; resetsAtMs?: number; claim?: string }

export function crewSeatWindowOf(frame: Record<string, unknown> | null): CrewSeatWindow | null {
  if (frame === null || frame.type !== 'rate_limit_event') return null
  const info = frame.rate_limit_info
  if (typeof info !== 'object' || info === null) return null
  const { status, resets_at: resetsAt, rate_limit_type: claim } = info as { status?: unknown; resets_at?: unknown; rate_limit_type?: unknown }
  const resetsAtMs = typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : undefined
  return { rejected: status === 'rejected', ...(resetsAtMs !== undefined ? { resetsAtMs } : {}), ...(typeof claim === 'string' ? { claim } : {}) }
}

const LIMIT_WORDS = /rate limit|usage limit|usage window|limit is (reached|spent)|\b429\b/i

export function crewSeatPauseOf(frame: Record<string, unknown> | null, window: CrewSeatWindow | undefined, model: string, nowMs: number = Date.now()): AgentPauseV1 | null {
  if (!isTurnResultParsedFrame(frame)) return null
  const error = errorTextOfParsedResultFrame(frame)
  if (error === undefined) return null
  const spent = window?.rejected === true || LIMIT_WORDS.test(error)
  if (!spent) return null
  const resumesAtMs = window?.resetsAtMs !== undefined && window.resetsAtMs > nowMs ? window.resetsAtMs : undefined
  const windowName = window?.claim === 'five_hour' ? 'session limit' : window?.claim === 'seven_day' ? 'weekly limit' : 'usage limit'
  const until = resumesAtMs !== undefined ? ` until ${pauseClockWords(resumesAtMs)}` : ''
  return { why: 'usage limit', words: `${model}'s ${windowName} is spent${until}`, ...(resumesAtMs !== undefined ? { resumesAtMs } : {}) }
}

export function crewSeatResumeFrame(accountChanged: boolean): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: accountChanged ? CREW_ACCOUNT_RESUME_NOTE : AGENT_WINDOW_RESUME_NOTE } })
}

export function crewSeatPausedLine(short: string, pause: AgentPauseV1, nowMs: number = Date.now()): string {
  return `[daemon] crew seat @${short} paused — ${pauseLineWords(pause, nowMs)}`
}

export function crewSeatResumedLine(short: string, accountChanged: boolean): string {
  return `[daemon] crew seat @${short} resumed by itself — ${accountChanged ? 'the operator signed in on another account' : 'the usage window reset'}`
}
