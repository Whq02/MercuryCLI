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
  const entries = new LRUCache<string, Result>({ max: maxCacheSize })
  const memoized = (...args: Args): Result => {
    const key = cacheFn(...args)
    const hit = entries.get(key)
    if (hit !== undefined) return hit
    const result = f(...args)
    entries.set(key, result)
    return result
  }
  memoized.cache = {
    clear: (): void => {
      entries.clear()
    },
    get size(): number {
      return entries.size
    },
    delete: (key: string): boolean => entries.delete(key),
    get: (key: string): Result | undefined => entries.peek(key),
    has: (key: string): boolean => entries.has(key),
  }
  return memoized
}
