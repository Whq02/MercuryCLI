import { flagEnv } from '../../substrate/flagRegistry.js'

export type UsageFeed = 'endpoint' | 'headers' | 'seed'

export const USAGE_POLL_TTL_MS = 60_000

export function usagePollTtlMs(): number {
  const raw = flagEnv('MERCURY_USAGE_POLL_MS')
  const ms = raw === undefined || raw === '' ? Number.NaN : Number(raw)
  return Number.isFinite(ms) && ms >= 1_000 && ms <= 3_600_000 ? ms : USAGE_POLL_TTL_MS
}

export function usageStaleAfterMs(): number {
  return 2 * usagePollTtlMs()
}

export const USAGE_RESPONSE_FRESH_MS = 5 * 60_000

export interface UsageFreshnessFacts {
  source?: UsageFeed
  observedAtMs?: number
  freshForMs?: number
}

export type UsageFreshness =
  | { state: 'live'; ageMs: number }
  | { state: 'stale'; ageMs: number }
  | { state: 'unstamped' }

export function usageFreshHorizonMs(source: UsageFeed | undefined): number {
  if (source === 'seed') return Number.POSITIVE_INFINITY
  if (source === 'endpoint') return usageStaleAfterMs()
  return USAGE_RESPONSE_FRESH_MS
}

export function usageFreshness(facts: UsageFreshnessFacts, now: number = Date.now()): UsageFreshness {
  if (facts.observedAtMs === undefined || !Number.isFinite(facts.observedAtMs)) return { state: 'unstamped' }
  const ageMs = Math.max(0, now - facts.observedAtMs)
  const horizon = facts.freshForMs ?? usageFreshHorizonMs(facts.source)
  return ageMs > horizon ? { state: 'stale', ageMs } : { state: 'live', ageMs }
}

export function usageFeedWord(source: UsageFeed | undefined): string | undefined {
  if (source === 'endpoint') return 'endpoint-fed'
  if (source === 'headers') return 'header-fed'
  if (source === 'seed') return 'seeded'
  return undefined
}

export function formatUsageAge(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 > 0 ? `${h} h ${m % 60} min` : `${h} h`
  return `${Math.floor(h / 24)} d`
}

export function formatUsageAgeShort(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function usageSourceWords(facts: UsageFreshnessFacts, now: number = Date.now()): string | undefined {
  const feed = usageFeedWord(facts.source)
  const fresh = usageFreshness(facts, now)
  const parts: string[] = []
  if (feed !== undefined) parts.push(feed)
  if (facts.source !== 'seed') {
    if (fresh.state === 'live') parts.push(`read ${formatUsageAge(fresh.ageMs)} ago`)
    else if (fresh.state === 'stale') parts.push(`stale · last read ${formatUsageAge(fresh.ageMs)} ago`)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export function usageStaleTail(facts: UsageFreshnessFacts, now: number = Date.now()): string | undefined {
  const fresh = usageFreshness(facts, now)
  return fresh.state === 'stale' ? `↻${formatUsageAgeShort(fresh.ageMs)}` : undefined
}

export function usageAgeTail(facts: UsageFreshnessFacts, now: number = Date.now()): string | undefined {
  const fresh = usageFreshness(facts, now)
  if (fresh.state === 'unstamped' || facts.source === 'seed') return undefined
  const age = `↻${formatUsageAgeShort(fresh.ageMs)}`
  return fresh.state === 'stale' ? `stale ${age}` : age
}

export function usageAgeWords(facts: UsageFreshnessFacts, now: number = Date.now()): string | undefined {
  const fresh = usageFreshness(facts, now)
  if (fresh.state === 'unstamped' || facts.source === 'seed') return undefined
  return fresh.state === 'stale' ? `stale · last read ${formatUsageAge(fresh.ageMs)} ago` : `read ${formatUsageAge(fresh.ageMs)} ago`
}

export const NO_USAGE_READ_WORDS = 'no usage read'
