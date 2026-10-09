import { pauseClockWords, pauseCountdownWords } from '../../tasks/LocalAgentTask/agentPause.js'

export function askToRunWords(toolName: string): string {
  return `asks to run ${toolName} — allow?`
}

export function askBoardQuestion(subject: string, toolName: string): string {
  return `"${subject}" ${askToRunWords(toolName)}`
}

export function askClockWords(askedAt: number, limitMs: number | undefined, nowMs: number): string | null {
  if (limitMs === undefined || !Number.isFinite(limitMs) || limitMs <= 0) return null
  const dueAt = askedAt + limitMs
  const left = dueAt - nowMs
  return left <= 0 ? 'refused by itself now' : `refused by itself at ${pauseClockWords(dueAt)} (in ${pauseCountdownWords(left)})`
}

export interface ParkedAskFacts {
  agentId?: string
  toolName: string
  askedAt: number
  limitMs?: number
}

export function parkedAskRowWords(ask: ParkedAskFacts, nowMs: number): string {
  const clock = askClockWords(ask.askedAt, ask.limitMs, nowMs)
  return clock === null ? askToRunWords(ask.toolName) : `${askToRunWords(ask.toolName)} · ${clock}`
}
