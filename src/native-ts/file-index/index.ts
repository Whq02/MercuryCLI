import { sleep } from '../../utils/sleep.js'
import { notBuilt, unbuilt } from '../../pi/holes.js'

type SearchResult = { path: string; score: number }

const CHUNK_MS = 4

function yieldToEventLoop(): Promise<void> {
  return sleep(0)
}

const MAX_QUERY_LENGTH = 64
const TOP_LEVEL_CAP = 100
const BOUNDARY_CHARS = new Set(['/', '\\', '-', '_', '.', ' '])

export class FileIndex {
  private paths: string[] = unbuilt('src/native-ts/file-index/index.ts:33')
  private lowerPaths: string[] = unbuilt('src/native-ts/file-index/index.ts:34')
  private bitmaps: number[] = unbuilt('src/native-ts/file-index/index.ts:35')
  private lengths: number[] = unbuilt('src/native-ts/file-index/index.ts:36')
  private readyCount: number = unbuilt('src/native-ts/file-index/index.ts:37')
  private topLevelCache: SearchResult[] | null = unbuilt('src/native-ts/file-index/index.ts:38')

  private reset(): void {
    return notBuilt('src/native-ts/file-index/index.ts:40')
  }

  private dedupe(list: string[]): string[] {
    return notBuilt('src/native-ts/file-index/index.ts:49')
  }

  private computeTopLevel(unique: string[]): void {
    return notBuilt('src/native-ts/file-index/index.ts:60')
  }

  private precomputeOne(index: number): void {
    return notBuilt('src/native-ts/file-index/index.ts:74')
  }

  loadFromFileList(list: string[]): void {
    return notBuilt('src/native-ts/file-index/index.ts:82')
  }

  loadFromFileListAsync(list: string[]): { queryable: Promise<void>; done: Promise<void> } {
    return notBuilt('src/native-ts/file-index/index.ts:91')
  }

  search(query: string, limit: number): SearchResult[] {
    return notBuilt('src/native-ts/file-index/index.ts:133')
  }
}


export default FileIndex
