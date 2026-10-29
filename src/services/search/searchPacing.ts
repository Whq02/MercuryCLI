import { KEYED_DOOR_REMEDY, type SearchBackendId, type SearchHit, type SearchRequest, type SearchTier } from './searchContract.js'

type PacedDoor = SearchBackendId | `searxng:${string}` | 'jina-reader'

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

const COOL_DOWN_BASE_MS = 30_000
export const COOL_DOWN_CAP_MS = 10 * 60_000
const COOL_DOWN_JITTER = 0.25
const STREAK_DECAY_MS = 2 * COOL_DOWN_CAP_MS

const RETRY_BACKOFF_MIN_MS = 1_500
const RETRY_BACKOFF_MAX_MS = 3_000

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

export function noteRateLimited(door: PacedDoor, clock: Pick<SearchClock, 'now' | 'random'>, minimumMs = 0): number {
  const now = clock.now()
  const prior = coolDowns.get(door)
  const refusals = prior && now - prior.lastRefusalAt <= STREAK_DECAY_MS ? prior.refusals + 1 : 1
  const window = Math.max(coolDownWindowMs(refusals, clock.random), minimumMs, (prior?.until ?? 0) - now)
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


interface CachedSearch {
  via: SearchBackendId
  tier: SearchTier
  hits: SearchHit[]
  queries: string[]
  landedAt: number
  notes?: string[]
  commentary?: string[]
}

const cache = new Map<string, CachedSearch>()

function sortedDomains(list: readonly string[] | undefined): string[] {
  return (list ?? [])
    .map(d => d.trim().toLowerCase())
    .filter(d => d !== '')
    .sort()
}

export function searchCacheKey(request: SearchRequest): string {
  return JSON.stringify([request.query.trim(), sortedDomains(request.allowedDomains), sortedDomains(request.blockedDomains), request.maxResults ?? null, request.cacheScope ?? null])
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
  cache.set(key, { via: answer.via, tier: answer.tier, hits: [...answer.hits], queries: [...answer.queries], ...(answer.notes ? { notes: [...answer.notes] } : {}), ...(answer.commentary?.length ? { commentary: [...answer.commentary] } : {}), landedAt: now })
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
  turns.clear()
  requestTimes.clear()
  nextRequestAt.clear()
  attempts.clear()
  cache.clear()
  keyedDoorHintSpent = false
  searchNotices.clear()
  groupSeq = 0
}

interface SearchRatePolicy {
  intervalMs: number
  windowMs?: number
  maxRequests?: number
  why: string
}

const turns = new Map<PacedDoor, Promise<void>>()
const requestTimes = new Map<PacedDoor, number[]>()
const nextRequestAt = new Map<PacedDoor, number>()

export async function withSearchTurn<T>(door: PacedDoor, policy: SearchRatePolicy, clock: SearchClock, signal: AbortSignal | undefined, run: (waitMs: number) => Promise<T>): Promise<T> {
  const prior = turns.get(door) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(resolve => { release = resolve })
  turns.set(door, next)
  const finish = (): void => {
    release()
    if (turns.get(door) === next) turns.delete(door)
  }
  const ready = await new Promise<boolean>(resolve => {
    const aborted = (): void => { signal?.removeEventListener('abort', aborted); resolve(false) }
    if (signal?.aborted) { aborted(); return }
    signal?.addEventListener('abort', aborted, { once: true })
    void prior.then(() => { signal?.removeEventListener('abort', aborted); resolve(true) })
  })
  if (!ready) {
    void prior.then(finish)
    return run(0)
  }
  try {
    let waitMs = coolDownRemainingMs(door, clock.now())
    if (signal?.aborted || waitMs > 0) return await run(waitMs)
    await clock.sleep(Math.max(0, (nextRequestAt.get(door) ?? 0) - clock.now()), signal)
    waitMs = coolDownRemainingMs(door, clock.now())
    if (signal?.aborted || waitMs > 0) return await run(waitMs)
    const now = clock.now()
    if (policy.maxRequests && policy.windowMs) {
      const times = (requestTimes.get(door) ?? []).filter(at => now - at < policy.windowMs!)
      requestTimes.set(door, times)
      if (times.length >= policy.maxRequests) return await run(times[0]! + policy.windowMs - now)
      times.push(now)
    }
    nextRequestAt.set(door, now + policy.intervalMs)
    return await run(0)
  } finally {
    release()
    if (turns.get(door) === next) turns.delete(door)
  }
}

export function serverSearchWaitMs(headers: Headers, now: number): number {
  const retry = headers.get('retry-after')
  const seconds = retry === null ? NaN : Number(retry)
  const retryMs = retry === null ? 0 : Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retry) - now) || 0
  const reset = Number(headers.get('x-ratelimit-reset')) * 1000
  const resetMs = headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) ? Math.max(0, reset - now) : 0
  return Math.max(retryMs, resetMs)
}

const attempts = new Map<string, number>()
export function reserveSearchAttempt(door: PacedDoor, words: string, now: number, intervalMs: number): number {
  const key = JSON.stringify([door, words.trim()])
  const left = Math.max(0, (attempts.get(key) ?? -Infinity) + intervalMs - now)
  if (left > 0) return left
  attempts.delete(key)
  attempts.set(key, now)
  while (attempts.size > 128) attempts.delete(attempts.keys().next().value!)
  return 0
}

const searchNotices = new Set<string>()
export function takeSearchNotice(key: string, text: string): string | undefined {
  if (searchNotices.has(key)) return undefined
  searchNotices.add(key)
  return text
}
