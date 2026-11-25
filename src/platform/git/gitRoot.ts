import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { LRUCache } from 'lru-cache'

import { passedOver } from '../errors/passedOver.js'


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
  let folder = resolve(startPath)
  let root: string | null = null
  while (root === null) {
    try {
      const entry = statSync(join(folder, '.git'))
      if (entry.isDirectory() || entry.isFile()) root = folder.normalize('NFC')
    } catch (error) {
      passedOver(error)
    }
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return root
})
