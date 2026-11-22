import { readdir } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

import { LRUCache } from 'lru-cache'

import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { expandPath } from '../path.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


type PathEntry = {
  name: string
  path: string
  kind: 'file' | 'directory'
}

type PathCompletionOptions = Unbuilt

type PathSuggestionItem = {
  id: string
  displayText: string
  description?: string
  metadata?: unknown
}

const SCAN_CAP = 100
const DEFAULT_MAX_RESULTS = 10
const CACHE_TTL_MS = 5 * 60 * 1000

const pathCache = new LRUCache<string, PathEntry[]>({ max: 500, ttl: CACHE_TTL_MS })

export async function getPathCompletions(
  partialPath: string,
  options?: PathCompletionOptions,
): Promise<PathSuggestionItem[]> {
  return notBuilt('src/utils/suggestions/directoryCompletion.ts:84')
}

export function isPathLikeToken(token: string): boolean {
  return notBuilt('src/utils/suggestions/directoryCompletion.ts:110')
}
