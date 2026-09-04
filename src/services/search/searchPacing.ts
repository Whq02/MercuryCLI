import { KEYED_DOOR_REMEDY, type SearchBackendId, type SearchHit, type SearchRequest, type SearchTier } from './searchContract.js'

export type PacedDoor = 'brave' | 'tavily' | 'duckduckgo' | 'duckduckgo-lite'

export interface SearchClock {
  now(): number
  random(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const liveSearchClock: SearchClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms, signal) =>
    new Promise<void>(resolve => {
      if (signal?.aborted) {
        resolve()
        return
      }
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
    }),
}

export const COOL_DOWN_BASE_MS = 30_000
export const COOL_DOWN_CAP_MS = 10 * 60_000
export const COOL_DOWN_JITTER = 0.25
const STREAK_DECAY_MS = 2 * COOL_DOWN_CAP_MS

export const RETRY_BACKOFF_MIN_MS = 1_500
export const RETRY_BACKOFF_MAX_MS = 3_000

export const SEARCH_CACHE_ENTRIES = 64
export const SEARCH_CACHE_TTL_MS = 10 * 60_000

interface CoolDown {
  until: number
  refusals: number
  lastRefusalAt: number
}

const coolDowns = new Map<PacedDoor, CoolDown>()

export function coolDownWindowMs(refusals: number, random: () => number): number {
  const streak = Math.max(1, refusals)
  const nominal = Math.min(COOL_DOWN_CAP_MS, COOL_DOWN_BASE_MS * 2 ** (streak - 1))
  const jitter = 1 + (random() * 2 - 1) * COOL_DOWN_JITTER
  return Math.round(nominal * jitter)
}

export function coolDownRemainingMs(door: PacedDoor, now: number): number {
  const entry = coolDowns.get(door)
  if (!entry) return 0
  return Math.max(0, entry.until - now)
}

export function noteRateLimited(door: PacedDoor, clock: Pick<SearchClock, 'now' | 'random'>): number {
  const now = clock.now()
  const prior = coolDowns.get(door)
  const refusals = prior && now - prior.lastRefusalAt <= STREAK_DECAY_MS ? prior.refusals + 1 : 1
  const window = coolDownWindowMs(refusals, clock.random)
  coolDowns.set(door, { until: now + window, refusals, lastRefusalAt: now })
  return window
}

export function noteAnswered(door: PacedDoor): void {
  coolDowns.delete(door)
}

export function retryBackoffMs(random: () => number): number {
  return Math.round(RETRY_BACKOFF_MIN_MS + random() * (RETRY_BACKOFF_MAX_MS - RETRY_BACKOFF_MIN_MS))
}

export function secondsLeftLabel(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}


export interface CachedSearch {
  via: SearchBackendId
  tier: SearchTier
  hits: SearchHit[]
  queries: string[]
  landedAt: number
}

const cache = new Map<string, CachedSearch>()

function sortedDomains(list: readonly string[] | undefined): string[] {
  return (list ?? [])
    .map(d => d.trim().toLowerCase())
    .filter(d => d !== '')
    .sort()
}

export function searchCacheKey(request: SearchRequest): string {
  return JSON.stringify([request.query.trim(), sortedDomains(request.allowedDomains), sortedDomains(request.blockedDomains), request.maxResults ?? null])
}

export function takeCachedSearch(request: SearchRequest, now: number): CachedSearch | undefined {
  const key = searchCacheKey(request)
  const entry = cache.get(key)
  if (!entry) return undefined
  if (now - entry.landedAt > SEARCH_CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

export function rememberSearch(request: SearchRequest, answer: Omit<CachedSearch, 'landedAt'>, now: number): void {
  const key = searchCacheKey(request)
  cache.delete(key)
  cache.set(key, { via: answer.via, tier: answer.tier, hits: [...answer.hits], queries: [...answer.queries], landedAt: now })
  while (cache.size > SEARCH_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function cachedAnswerNote(doorLabel: string): string {
  return `answered from this session's search cache — the same query landed via ${doorLabel} within the last ${SEARCH_CACHE_TTL_MS / 60_000} minutes; no door was knocked`
}


let keyedDoorHintSpent = false

export function takeKeyedDoorHint(): string | undefined {
  if (keyedDoorHintSpent) return undefined
  keyedDoorHintSpent = true
  return KEYED_DOOR_REMEDY
}


let groupSeq = 0

export function nextSearchGroupId(via: SearchBackendId): string {
  return `${via}-${++groupSeq}`
}

export function resetSearchPacing(): void {
  coolDowns.clear()
  cache.clear()
  keyedDoorHintSpent = false
  groupSeq = 0
}
