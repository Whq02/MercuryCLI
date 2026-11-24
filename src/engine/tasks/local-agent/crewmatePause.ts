
type CrewmatePauseWhy = 'usage limit' | 'provider busy' | 'provider overloaded'

export type CrewmatePauseV1 = {
  why: CrewmatePauseWhy
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

export const CREWMATE_PAUSE_DOORS = 'a message resumes it now (/model first runs it on another model); the crew view stops it'

export const CREWMATE_WINDOW_RESUME_NOTE =
  'The usage window reset and you were resumed by yourself after it paused you. Continue from where your transcript ends — the work before the pause stands; do not redo it.'

export const CREW_ACCOUNT_RESUME_NOTE =
  'The operator signed in on another account and you were resumed by yourself after a usage limit paused you. Continue from where your transcript ends — the work before the pause stands; do not redo it.'

export function pauseResumeWords(pause: Pick<CrewmatePauseV1, 'why' | 'resumesAtMs'>, nowMs: number): string {
  if (pause.resumesAtMs === undefined) return pause.why === 'provider overloaded' ? 'resumes by itself when the provider answers' : 'no reset stated — a message resumes it'
  const left = pause.resumesAtMs - nowMs
  return left <= 0 ? 'resuming now' : `retries by itself at ${pauseClockWords(pause.resumesAtMs)} (in ${pauseCountdownWords(left)})`
}

export function pauseStatusWords(pause: CrewmatePauseV1, nowMs: number): string {
  if (pause.why === 'provider overloaded') return `paused — ${pause.why} · ${pauseResumeWords(pause, nowMs)}`
  return `paused — ${pause.words} · ${pauseResumeWords(pause, nowMs)} · r retries now`
}

export function pauseLineWords(pause: CrewmatePauseV1, nowMs: number): string {
  return `${pauseStatusWords(pause, nowMs)}; ${pause.why === 'provider overloaded' ? `${pause.words}; ` : ''}${CREWMATE_PAUSE_DOORS}`
}

export function decodeCrewmatePause(raw: unknown): CrewmatePauseV1 | null {
  if (raw === null || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if ((p.why !== 'usage limit' && p.why !== 'provider busy' && p.why !== 'provider overloaded') || typeof p.words !== 'string') return null
  const resumesAtMs = typeof p.resumesAtMs === 'number' && Number.isFinite(p.resumesAtMs) ? p.resumesAtMs : undefined
  return { why: p.why, words: p.words, ...(resumesAtMs !== undefined ? { resumesAtMs } : {}) }
}
