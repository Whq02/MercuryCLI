import { resolve } from 'node:path'
import { LRUCache } from 'lru-cache'
import { getCwd } from './cwd.js'

const DEFAULT_CWD_MEMO_CAP = 64

type Box<V> = { value: V }

type CwdMemoCache<V> = {
  has(key: unknown): boolean
  get(key: unknown): V | undefined
  set(key: unknown, value: V): CwdMemoCache<V>
  delete(key: unknown): boolean
  clear(): void
  readonly size: number
}

export function memoizeByCwd<T>(
  compute: () => T,
  cap: number = DEFAULT_CWD_MEMO_CAP,
): (() => T) & { cache: CwdMemoCache<T> } {
  const entries = new LRUCache<string, Box<T>>({ max: cap })
  const keyOf = (key: unknown): string => (key === undefined ? resolve(getCwd()) : resolve(String(key)))
  const cache: CwdMemoCache<T> = {
    has: (key: unknown) => entries.has(keyOf(key)),
    get: (key: unknown) => entries.peek(keyOf(key))?.value,
    set: (key: unknown, value: T) => {
      entries.set(keyOf(key), { value })
      return cache
    },
    delete: (key: unknown) => entries.delete(keyOf(key)),
    clear: () => {
      entries.clear()
    },
    get size(): number {
      return entries.size
    },
  }
  const memo = (): T => {
    const key = resolve(getCwd())
    const hit = entries.get(key)
    if (hit !== undefined) return hit.value
    const value = compute()
    entries.set(key, { value })
    return value
  }
  memo.cache = cache
  return memo
}
