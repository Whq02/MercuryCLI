import { AGENT_WINDOW_RESUME_NOTE, CREW_ACCOUNT_RESUME_NOTE, pauseClockWords, pauseLineWords, type AgentPauseV1 } from '../tasks/LocalAgentTask/agentPause.js'
import { errorTextOfOutcome, isOutcomeRow } from './longLivedSupervisor.js'
import type { LooseRow } from '../rows/read.js'

export type CrewSeatWindow = { rejected: boolean; resetsAtMs?: number; claim?: string }

export function crewSeatWindowOf(row: LooseRow | null): CrewSeatWindow | null {
  if (row === null || row.type !== 'rate_limit') return null
  const { status, resets_at: resetsAt, window: claim } = row as { status?: unknown; resets_at?: unknown; window?: unknown }
  const resetsAtMs = typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : undefined
  return { rejected: status === 'rejected', ...(resetsAtMs !== undefined ? { resetsAtMs } : {}), ...(typeof claim === 'string' ? { claim } : {}) }
}

const LIMIT_WORDS = /rate limit|usage limit|usage window|limit is (reached|spent)|\b429\b/i

export function crewSeatPauseOf(row: LooseRow | null, window: CrewSeatWindow | undefined, model: string, nowMs: number = Date.now()): AgentPauseV1 | null {
  if (!isOutcomeRow(row)) return null
  const error = errorTextOfOutcome(row)
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
