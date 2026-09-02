import { normalize } from 'node:path'

import { LRUCache } from 'lru-cache'

/**
 * A bounded LRU of "what the model has read", keyed by NORMALISED paths (the
 * platform normaliser: redundant separators, `.`/`..` segments and Windows
 * separators unified — but not absolutised, so a relative and an absolute
 * spelling of one file remain two keys).
 */

export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  /**
   * Set when the entry was populated by automatic injection and what the
   * model saw did not match disk (comments/frontmatter stripped, content
   * truncated). Then `content` holds the RAW disk bytes: an edit/write is
   * forced to require an explicit read first, while change detection still
   * has the true bytes to diff.
   */
  isPartialView?: boolean
}

export const READ_FILE_STATE_CACHE_SIZE = 100
const DEFAULT_MAX_SIZE_BYTES = 25 * 1024 * 1024

function entrySize(state: FileState): number {
  return Math.max(1, Buffer.byteLength(state.content))
}

export class FileStateCache {
  private readonly cache: LRUCache<string, FileState>
  readonly max: number
  readonly maxSize: number

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.max = maxEntries
    this.maxSize = maxSizeBytes
    this.cache = new LRUCache<string, FileState>({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: entrySize,
    })
  }

  private key(path: string): string {
    return normalize(path)
  }

  /** A get counts as a use and reorders recency. */
  get(path: string): FileState | undefined {
    return this.cache.get(this.key(path))
  }

  set(path: string, state: FileState): this {
    this.cache.set(this.key(path), state)
    return this
  }

  has(path: string): boolean {
    return this.cache.has(this.key(path))
  }

  delete(path: string): boolean {
    return this.cache.delete(this.key(path))
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }

  get calculatedSize(): number {
    return this.cache.calculatedSize
  }

  /** Recency order — most recently used first. */
  keys(): IterableIterator<string> {
    return this.cache.keys()
  }

  entries(): IterableIterator<[string, FileState]> {
    return this.cache.entries()
  }

  dump(): Array<[string, LRUCache.Entry<FileState>]> {
    return this.cache.dump()
  }

  load(entries: Array<[string, LRUCache.Entry<FileState>]>): void {
    this.cache.load(entries)
  }
}

export function createFileStateCacheWithSizeLimit(
  maxEntries: number,
  maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES,
): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes)
}

export function cacheToObject(cache: FileStateCache): Record<string, FileState> {
  const result: Record<string, FileState> = {}
  for (const [key, value] of cache.entries()) {
    result[key] = value
  }
  return result
}

export function cacheKeys(cache: FileStateCache): string[] {
  return [...cache.keys()]
}

/** Clone preserving both limits. */
export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  const clone = new FileStateCache(cache.max, cache.maxSize)
  clone.load(cache.dump())
  return clone
}

/**
 * Merge two caches: for a key in both, the STRICTLY greater timestamp wins
 * and ties keep the first cache's entry.
 */
export function mergeFileStateCaches(first: FileStateCache, second: FileStateCache): FileStateCache {
  const merged = cloneFileStateCache(first)
  for (const [key, state] of second.entries()) {
    const existing = merged.get(key)
    if (!existing || state.timestamp > existing.timestamp) {
      merged.set(key, state)
    }
  }
  return merged
}
