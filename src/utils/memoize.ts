import { LRUCache } from 'lru-cache'

import { logError } from './log.js'

/**
 * Two memoisation strategies: TTL with background refresh (asynchronous,
 * with in-flight de-duplication) and bounded LRU. (The synchronous TTL
 * variant has no caller and is not built.)
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000

type TtlEntry<Result> = {
  value: Result
  timestamp: number
  refreshing: boolean
}

/**
 * Keyed by a JSON serialisation of the arguments. A cold miss computes,
 * stores and returns; a hit within the lifetime returns the stored value; a
 * stale hit marks the entry as refreshing, schedules the recomputation and
 * returns the STALE value immediately.
 *
 * Cold misses are de-duplicated through a second map of in-flight promises:
 * an async memo that awaits before storing has no cache entry for overlapping
 * callers to collide on, so without this every caller during the first
 * computation starts another one (N interactive sign-in subprocesses, in the
 * recorded case).
 *
 * Every store and delete is identity-guarded against the entry it started
 * from: a clear followed by a fresh cold miss while a refresh is queued leaves
 * a NEWER entry under the key, and overwriting it would serve a wrong value
 * for a whole lifetime, whereas an erroneous delete costs one recomputation.
 */
export function memoizeWithTTLAsync<Args extends unknown[], Result>(
  f: (...args: Args) => Promise<Result>,
  cacheLifetimeMs: number = DEFAULT_TTL_MS,
): ((...args: Args) => Promise<Result>) & { cache: { clear(): void } } {
  const cache = new Map<string, TtlEntry<Result>>()
  const inFlight = new Map<string, Promise<Result>>()

  const memoized = async (...args: Args): Promise<Result> => {
    const key = JSON.stringify(args)
    const now = Date.now()
    const entry = cache.get(key)
    if (entry) {
      if (now - entry.timestamp < cacheLifetimeMs) return entry.value
      if (!entry.refreshing) {
        entry.refreshing = true
        void Promise.resolve().then(async () => {
          try {
            const value = await f(...args)
            if (cache.get(key) === entry) cache.set(key, { value, timestamp: Date.now(), refreshing: false })
          } catch (err) {
            logError(err)
            if (cache.get(key) === entry) cache.delete(key)
          }
        })
      }
      return entry.value
    }
    const pending = inFlight.get(key)
    if (pending) return pending
    // The timestamp is the time BEFORE the await.
    const startedAt = now
    let promise!: Promise<Result>
    promise = (async () => {
      try {
        const value = await f(...args)
        // A clear during the await discards the result (invalidation intent).
        if (inFlight.get(key) === promise) {
          cache.set(key, { value, timestamp: startedAt, refreshing: false })
        }
        return value
      } finally {
        // Identity-guarded so a stale promise cannot delete a fresh one.
        if (inFlight.get(key) === promise) inFlight.delete(key)
      }
    })()
    inFlight.set(key, promise)
    return promise
  }

  memoized.cache = {
    clear(): void {
      cache.clear()
      inFlight.clear()
    },
  }
  return memoized as ((...args: Args) => Promise<Result>) & { cache: { clear(): void } }
}

/**
 * Bounded LRU memoisation. `undefined` is the miss signal, so the result type
 * must be non-nullable. `get` observes without promoting.
 */
export function memoizeWithLRU<Args extends unknown[], Result extends NonNullable<unknown>>(
  f: (...args: Args) => Result,
  cacheFn: (...args: Args) => string,
  maxCacheSize: number = 100,
): ((...args: Args) => Result) & {
  cache: {
    clear(): void
    size: number
    delete(key: string): boolean
    get(key: string): Result | undefined
    has(key: string): boolean
  }
} {
  const cache = new LRUCache<string, Result>({ max: maxCacheSize })
  const memoized = (...args: Args): Result => {
    const key = cacheFn(...args)
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const value = f(...args)
    cache.set(key, value)
    return value
  }
  memoized.cache = {
    clear(): void {
      cache.clear()
    },
    get size(): number {
      return cache.size
    },
    delete(key: string): boolean {
      return cache.delete(key)
    },
    get(key: string): Result | undefined {
      return cache.peek(key)
    },
    has(key: string): boolean {
      return cache.has(key)
    },
  }
  return memoized as ((...args: Args) => Result) & {
    cache: {
      clear(): void
      size: number
      delete(key: string): boolean
      get(key: string): Result | undefined
      has(key: string): boolean
    }
  }
}
