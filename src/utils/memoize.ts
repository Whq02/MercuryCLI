import { LRUCache } from 'lru-cache'


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
