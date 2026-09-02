import { LRUCache } from 'lru-cache'

import { logError } from './log.js'


const DEFAULT_TTL_MS = 5 * 60 * 1000

type TtlEntry<Result> = {
  value: Result
  timestamp: number
  refreshing: boolean
}

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
    const startedAt = now
    let promise!: Promise<Result>
    promise = (async () => {
      try {
        const value = await f(...args)
        if (inFlight.get(key) === promise) {
          cache.set(key, { value, timestamp: startedAt, refreshing: false })
        }
        return value
      } finally {
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
