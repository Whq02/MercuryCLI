import { normalize } from 'node:path'
import { LRUCache } from 'lru-cache'
import { isRemotePath } from '../remote-file-target/target.js'

export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  isPartialView?: boolean
  sqliteRowIdentity?: string
}

export const READ_FILE_STATE_CACHE_SIZE = 100

type Snapshot = [string, LRUCache.Entry<FileState>][]

function cacheKey(path: string): string {
  return isRemotePath(path) ? path : normalize(path)
}

export class FileStateCache {
  private readonly store: LRUCache<string, FileState>

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.store = new LRUCache({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: state => Math.max(1, Buffer.byteLength(state.content, 'utf8')),
    })
  }

  get max(): number {
    return this.store.max
  }

  get maxSize(): number {
    return this.store.maxSize
  }

  get size(): number {
    return this.store.size
  }

  get calculatedSize(): number {
    return this.store.calculatedSize
  }

  get(path: string): FileState | undefined {
    return this.store.get(cacheKey(path))
  }

  set(path: string, state: FileState): this {
    this.store.set(cacheKey(path), state)
    return this
  }

  has(path: string): boolean {
    return this.store.has(cacheKey(path))
  }

  delete(path: string): boolean {
    return this.store.delete(cacheKey(path))
  }

  clear(): void {
    this.store.clear()
  }

  keys(): IterableIterator<string> {
    return this.store.keys()
  }

  entries(): IterableIterator<[string, FileState]> {
    return this.store.entries()
  }

  dump(): Snapshot {
    return this.store.dump()
  }

  load(entries: Snapshot): void {
    this.store.load(entries)
  }
}

export function createFileStateCacheWithSizeLimit(maxEntries: number, maxSizeBytes = 25 * 1024 * 1024): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes)
}

export function cacheKeys(cache: FileStateCache): string[] {
  return [...cache.keys()]
}

export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  const copy = new FileStateCache(cache.max, cache.maxSize)
  copy.load(cache.dump())
  return copy
}
