import { needsPowerShellBom } from './fileEncoding.js'
import { readFileSyncWithMetadata } from './fileRead.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'

const MAX_ENTRIES = 1000

type CachedFileEntry = {
  content: string
  encoding: BufferEncoding
  mtimeMs: number
  size: number
}

type FileReadCacheStats = {
  size: number
  keys: string[]
}

type FileReadCache = {
  readFile(filePath: string): { content: string; encoding: BufferEncoding }
  clear(): void
  invalidate(filePath: string): void
  getStats(): FileReadCacheStats
}

const entries = new Map<string, CachedFileEntry>()

export const fileReadCache: FileReadCache = {
  readFile(filePath: string): { content: string; encoding: BufferEncoding } {
    const fs = getFsImplementation()
    const { resolvedPath } = safeResolvePath(fs, filePath)
    let stats: { mtimeMs: number; size: number }
    try {
      stats = fs.statSync(resolvedPath)
    } catch (error) {
      entries.delete(filePath)
      throw error
    }
    const cached = entries.get(filePath)
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return { content: cached.content, encoding: cached.encoding }
    }
    let { content, encoding } = readFileSyncWithMetadata(filePath)
    if (content.startsWith('\uFEFF') && needsPowerShellBom(filePath)) {
      content = content.slice(1)
    }
    if (!entries.has(filePath) && entries.size >= MAX_ENTRIES) {
      const oldestKey = entries.keys().next().value
      if (oldestKey !== undefined) entries.delete(oldestKey)
    }
    entries.set(filePath, { content, encoding, mtimeMs: stats.mtimeMs, size: stats.size })
    return { content, encoding }
  },

  clear(): void {
    entries.clear()
  },

  invalidate(filePath: string): void {
    entries.delete(filePath)
  },

  getStats(): FileReadCacheStats {
    return {
      size: entries.size,
      keys: [...entries.keys()],
    }
  },
}
