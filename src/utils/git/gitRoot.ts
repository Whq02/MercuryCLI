import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { LRUCache } from 'lru-cache'

import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { passedOver } from '../passedOver.js'


const ROOT_CACHE_ENTRIES = 50


type RootMemo = { root: string | null }
export type CachedFinder = ((startPath: string) => string | null) & { cache: LRUCache<string, RootMemo> }

export function makeCachedFinder(compute: (startPath: string) => string | null): CachedFinder {
  const cache = new LRUCache<string, RootMemo>({ max: ROOT_CACHE_ENTRIES })
  const finder = ((startPath: string): string | null => {
    const memo = cache.get(startPath)
    if (memo) return memo.root
    const root = compute(startPath)
    cache.set(startPath, { root })
    return root
  }) as CachedFinder
  finder.cache = cache
  return finder
}

export const findGitRoot: CachedFinder = makeCachedFinder(startPath => {
  const startedAt = Date.now()
  let stats = 0
  logForDiagnosticsNoPII('debug', 'git_root_discovery_started')
  let current = resolve(startPath)
  for (;;) {
    stats++
    try {
      const entry = statSync(join(current, '.git'))
      if (entry.isDirectory() || entry.isFile()) {
        logForDiagnosticsNoPII('debug', 'git_root_discovery_completed', { found: true, stats, duration_ms: Date.now() - startedAt })
        return current.normalize('NFC')
      }
    } catch (error) {
      passedOver(error)
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  logForDiagnosticsNoPII('debug', 'git_root_discovery_completed', { found: false, stats, duration_ms: Date.now() - startedAt })
  return null
})
