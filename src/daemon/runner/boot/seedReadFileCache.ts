import { type FileState, READ_FILE_STATE_CACHE_SIZE, createFileStateCacheWithSizeLimit, type FileStateCache } from '../../../platform/files/fileStateCache.js'
import { extractReadFilesFromMessages } from '../../../engine/turn-entry/filesReadInMessages.js'
import { getCwd } from '../../../platform/files/cwd.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'getReadFileCache' | 'setReadFileCache'> {
  const { live, messages } = ports
  const pendingSeeds = new Map<string, FileState>()
  live.readFileCache = messages.length > 0
      ? extractReadFilesFromMessages(messages, getCwd(), READ_FILE_STATE_CACHE_SIZE)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
  const getReadFileCache = (): FileStateCache => {
    if (pendingSeeds.size === 0) return live.readFileCache
    const merged = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    for (const [key, value] of pendingSeeds) merged.set(key, value)
    for (const key of live.readFileCache.keys()) {
      const value = live.readFileCache.get(key)
      if (value !== undefined) merged.set(key, value)
    }
    return merged
  }
  const setReadFileCache = (cache: FileStateCache): void => {
    live.readFileCache = cache
    for (const [key, seed] of pendingSeeds) {
      const existing = live.readFileCache.get(key)
      if (!existing || seed.timestamp > existing.timestamp) {
        live.readFileCache.set(key, seed)
      }
    }
    pendingSeeds.clear()
  }
  return { getReadFileCache, setReadFileCache }
}

export const seedReadFileCache: BootStep<'getReadFileCache' | 'setReadFileCache'> = { name: 'seedReadFileCache', makes: ['getReadFileCache', 'setReadFileCache'], run }
