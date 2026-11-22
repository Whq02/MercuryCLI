import { LRUCache } from 'lru-cache'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export type FileState = Unbuilt

export const READ_FILE_STATE_CACHE_SIZE: Unbuilt = unbuilt('src/utils/fileStateCache.ts:16')

type Snapshot = Unbuilt[]

export class FileStateCache {
  private readonly store: LRUCache<string, FileState>

  constructor(maxEntries: number, maxSizeBytes: number) {
    notBuilt('src/utils/fileStateCache.ts:31')
  }

  get max(): number {
    return notBuilt('src/utils/fileStateCache.ts:35')
  }

  get maxSize(): number {
    return notBuilt('src/utils/fileStateCache.ts:39')
  }

  get size(): number {
    return notBuilt('src/utils/fileStateCache.ts:43')
  }

  get calculatedSize(): number {
    return notBuilt('src/utils/fileStateCache.ts:47')
  }

  get(path: string): FileState | undefined {
    return notBuilt('src/utils/fileStateCache.ts:51')
  }

  set(path: string, state: FileState): this {
    return notBuilt('src/utils/fileStateCache.ts:55')
  }

  has(path: string): boolean {
    return notBuilt('src/utils/fileStateCache.ts:60')
  }

  delete(path: string): boolean {
    return notBuilt('src/utils/fileStateCache.ts:64')
  }

  clear(): void {
    return notBuilt('src/utils/fileStateCache.ts:68')
  }

  keys(): IterableIterator<string> {
    return notBuilt('src/utils/fileStateCache.ts:72')
  }

  entries(): IterableIterator<[string, FileState]> {
    return notBuilt('src/utils/fileStateCache.ts:76')
  }

  dump(): Snapshot {
    return notBuilt('src/utils/fileStateCache.ts:80')
  }

  load(entries: Snapshot): void {
    return notBuilt('src/utils/fileStateCache.ts:84')
  }
}

export function createFileStateCacheWithSizeLimit(maxEntries: number, maxSizeBytes?: number): FileStateCache {
  return notBuilt('src/utils/fileStateCache.ts:89')
}

export function cacheKeys(cache: FileStateCache): string[] {
  return notBuilt('src/utils/fileStateCache.ts:93')
}

export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  return notBuilt('src/utils/fileStateCache.ts:97')
}
