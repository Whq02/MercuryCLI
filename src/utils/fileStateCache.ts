import { normalize } from 'node:path'

import { LRUCache } from 'lru-cache'

export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  isPartialView?: boolean
}

export const READ_FILE_STATE_CACHE_SIZE = 100
const DEFAULT_MAX_SIZE_BYTES = 25 * 1024 * 1024

type Snapshot = Array<[string, LRUCache.Entry<FileState>]>

const weightOf = ({ content }: FileState): number => Math.max(1, Buffer.byteLength(content))

const boundedStore = (max: number, maxSize: number): LRUCache<string, FileState> =>
  new LRUCache<string, FileState>({ max, maxSize, sizeCalculation: weightOf })

export class FileStateCache {
  private readonly store: LRUCache<string, FileState>

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.store = boundedStore(maxEntries, maxSizeBytes)
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
    return this.store.get(normalize(path))
  }

  set(path: string, state: FileState): this {
    this.store.set(normalize(path), state)
    return this
  }

  has(path: string): boolean {
    return this.store.has(normalize(path))
  }

  delete(path: string): boolean {
    return this.store.delete(normalize(path))
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

export function createFileStateCacheWithSizeLimit(maxEntries: number, maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes)
}

export function cacheKeys(cache: FileStateCache): string[] {
  return Array.from(cache.keys())
}

export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  const clone = createFileStateCacheWithSizeLimit(cache.max, cache.maxSize)
  clone.load(cache.dump())
  return clone
}
