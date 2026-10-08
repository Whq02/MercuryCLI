
export type AgentPauseWhy = 'usage limit' | 'provider busy' | 'provider overloaded'

export type AgentPauseV1 = {
  why: AgentPauseWhy
  words: string
  resumesAtMs?: number
}

export function pauseClockWords(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function pauseCountdownWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? `${h}h${rem}m` : `${h}h`
}

export const AGENT_PAUSE_DOORS = 'a message resumes it now (/model first runs it on another model); the crew view stops it'

export const AGENT_WINDOW_RESUME_NOTE =
  'The usage window reset and you were resumed by yourself after it paused you. Continue from where your transcript ends — the work before the pause stands; do not redo it.'

export const CREW_ACCOUNT_RESUME_NOTE =
  'The operator signed in on another account and you were resumed by yourself after a usage limit paused you. Continue from where your transcript ends — the work before the pause stands; do not redo it.'

export function pauseResumeWords(pause: Pick<AgentPauseV1, 'why' | 'resumesAtMs'>, nowMs: number): string {
  if (pause.resumesAtMs === undefined) return pause.why === 'provider overloaded' ? 'resumes by itself when the provider answers' : 'no reset stated — a message resumes it'
  const left = pause.resumesAtMs - nowMs
  return left <= 0 ? 'resuming now' : `retries by itself at ${pauseClockWords(pause.resumesAtMs)} (in ${pauseCountdownWords(left)})`
}

export function pauseStatusWords(pause: AgentPauseV1, nowMs: number): string {
  if (pause.why === 'provider overloaded') return `paused — ${pause.why} · ${pauseResumeWords(pause, nowMs)}`
  return `paused — ${pause.words} · ${pauseResumeWords(pause, nowMs)} · r retries now`
}

export function pauseLineWords(pause: AgentPauseV1, nowMs: number): string {
  return `${pauseStatusWords(pause, nowMs)}; ${pause.why === 'provider overloaded' ? `${pause.words}; ` : ''}${AGENT_PAUSE_DOORS}`
}

export function decodeAgentPause(raw: unknown): AgentPauseV1 | null {
  if (raw === null || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if ((p.why !== 'usage limit' && p.why !== 'provider busy' && p.why !== 'provider overloaded') || typeof p.words !== 'string') return null
  const resumesAtMs = typeof p.resumesAtMs === 'number' && Number.isFinite(p.resumesAtMs) ? p.resumesAtMs : undefined
  return { why: p.why, words: p.words, ...(resumesAtMs !== undefined ? { resumesAtMs } : {}) }
}
