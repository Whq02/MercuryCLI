import { LRUCache } from 'lru-cache'
import { notBuilt } from '../pi/holes.js'


export function memoizeWithLRU<Args extends unknown[], Result extends NonNullable<unknown>>(
  f: (...args: Args) => Result,
  cacheFn: (...args: Args) => string,
  maxCacheSize?: number,
): ((...args: Args) => Result) & {
  cache: {
    clear(): void
    size: number
    delete(key: string): boolean
    get(key: string): Result | undefined
    has(key: string): boolean
  }
} {
  return notBuilt('src/utils/memoize.ts:5')
}
