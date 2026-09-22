import { flagEnv } from '../../substrate/flagRegistry.js'
import { pauseCountdownWords } from './agentPause.js'

export const OVERLOAD_PROBE_FIRST_MS = 30_000
export const OVERLOAD_PROBE_EARLY_MS = 60_000
export const OVERLOAD_PROBE_EARLY_WINDOW_MS = 10 * 60_000
export const OVERLOAD_PROBE_LATE_MS = 5 * 60_000
export const OVERLOAD_PROBE_WINDOW_MS = 2 * 60 * 60_000
export const OVERLOAD_PROBE_REQUEST_MS = 30_000

export function overloadProbeScale(): number {
  const raw = flagEnv('MERCURY_OVERLOAD_PROBE_SCALE')
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export interface OverloadEpisode {
  readonly openedAtMs: number
  readonly untilMs: number
  readonly scale: number
  deaths: number
  probes: number
}

export function openOverloadEpisode(nowMs: number, scale: number = overloadProbeScale()): OverloadEpisode {
  return { openedAtMs: nowMs, untilMs: nowMs + Math.max(1, Math.round(OVERLOAD_PROBE_WINDOW_MS * scale)), scale, deaths: 0, probes: 0 }
}

export function noteOverloadDeath(episode: OverloadEpisode): { first: boolean; deaths: number } {
  episode.deaths += 1
  return { first: episode.deaths === 1, deaths: episode.deaths }
}

export function overloadDeathNotifies(episode: OverloadEpisode): boolean {
  return episode.deaths >= 1
}

export function nextOverloadProbeDelayMs(episode: OverloadEpisode, nowMs: number, afterDeath: boolean): number | null {
  const left = episode.untilMs - nowMs
  if (left <= 0) return null
  const elapsed = nowMs - episode.openedAtMs
  const cadence = afterDeath ? OVERLOAD_PROBE_FIRST_MS : elapsed < OVERLOAD_PROBE_EARLY_WINDOW_MS * episode.scale ? OVERLOAD_PROBE_EARLY_MS : OVERLOAD_PROBE_LATE_MS
  return Math.min(left, Math.max(1, Math.round(cadence * episode.scale)))
}

export function overloadProbeRequestMs(scale: number = overloadProbeScale()): number {
  return Math.max(1, Math.round(OVERLOAD_PROBE_REQUEST_MS * scale))
}

const OVERLOADED_MARKER = '"type":"overloaded_error"'

export function isOverloadAnswerText(text: string): boolean {
  return text.includes(OVERLOADED_MARKER) || /^API Error: 529\b/.test(text) || /API overload errors \(529\)/.test(text)
}

export function overloadProbeWindowWords(scale: number = overloadProbeScale()): string {
  return pauseCountdownWords(Math.round(OVERLOAD_PROBE_WINDOW_MS * scale))
}

export function overloadPauseWords(who: string, scale: number = overloadProbeScale()): string {
  return `${who} is overloaded (HTTP 529) — Mercury probes it for up to ${overloadProbeWindowWords(scale)} and resumes the agent when it answers`
}

export function overloadNoticeWords(description: string, who: string, scale: number = overloadProbeScale()): string {
  return `Agent "${description}" paused — ${who} is overloaded (HTTP 529); its work so far is kept and rides below; Mercury probes the provider for up to ${overloadProbeWindowWords(scale)} and resumes the agent by itself when it answers — a message resumes it sooner; the crew view stops it`
}

export const AGENT_OVERLOAD_RESUME_NOTE =
  'The provider is answering again and you were resumed by yourself after it was overloaded and paused you. Continue from where your transcript ends — the work before the pause stands; do not redo it.'
