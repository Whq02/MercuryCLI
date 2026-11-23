import { resolve } from 'node:path'
import { readFileSyncWithMetadata } from './fileRead.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { passedOver } from './passedOver.js'

const MAX_ENTRIES = 1000

export type FileReadCacheEntry = {
  content: string
  encoding: BufferEncoding
  mtimeMs: number
  size: number
}

export type FileReadCache = {
  readFile(filePath: string): { content: string; encoding: BufferEncoding }
  get(filePath: string): FileReadCacheEntry | undefined
  set(filePath: string, entry: FileReadCacheEntry): void
  delete(filePath: string): boolean
  clear(): void
}

const entries = new Map<string, FileReadCacheEntry>()

function setEntry(key: string, entry: FileReadCacheEntry): void {
  if (!entries.has(key) && entries.size >= MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value
    if (oldestKey !== undefined) entries.delete(oldestKey)
  }
  entries.set(key, entry)
}

export const fileReadCache: FileReadCache = {
  readFile(filePath: string): { content: string; encoding: BufferEncoding } {
    const fs = getFsImplementation()
    const key = resolve(filePath)
    const { resolvedPath } = safeResolvePath(fs, key)
    const stats = fs.statSync(resolvedPath)
    const cached = entries.get(key)
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return { content: cached.content, encoding: cached.encoding }
    }
    const { content, encoding } = readFileSyncWithMetadata(key)
    setEntry(key, { content, encoding, mtimeMs: stats.mtimeMs, size: stats.size })
    return { content, encoding }
  },

  get(filePath: string): FileReadCacheEntry | undefined {
    const key = resolve(filePath)
    const cached = entries.get(key)
    if (cached === undefined) return undefined
    try {
      const fs = getFsImplementation()
      const { resolvedPath } = safeResolvePath(fs, key)
      const stats = fs.statSync(resolvedPath)
      if (cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
        entries.delete(key)
        return undefined
      }
      return cached
    } catch (error) {
      passedOver(error)
      entries.delete(key)
      return undefined
    }
  },

  set(filePath: string, entry: FileReadCacheEntry): void {
    setEntry(resolve(filePath), entry)
  },

  delete(filePath: string): boolean {
    return entries.delete(resolve(filePath))
  },

  clear(): void {
    entries.clear()
  },
}
