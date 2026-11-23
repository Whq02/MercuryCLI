import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { LRUCache } from 'lru-cache'

import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { expandPath } from '../path.js'


type PathEntry = {
  name: string
  path: string
  kind: 'file' | 'directory'
}

type PathCompletionOptions = {
  basePath?: string
  maxResults?: number
  includeHidden?: boolean
  directoriesOnly?: boolean
}

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

function splitPartialPath(partialPath: string): {
  rawDir: string
  displayPrefix: string
  namePrefix: string
} {
  if (partialPath === '~') {
    return { rawDir: '~/', displayPrefix: '~/', namePrefix: '' }
  }
  const lastSep = Math.max(partialPath.lastIndexOf('/'), partialPath.lastIndexOf('\\'))
  if (lastSep === -1) {
    return { rawDir: '', displayPrefix: '', namePrefix: partialPath }
  }
  const prefix = partialPath.slice(0, lastSep + 1)
  return {
    rawDir: prefix,
    displayPrefix: prefix,
    namePrefix: partialPath.slice(lastSep + 1),
  }
}

async function listDirectoryEntries(
  dirPath: string,
  includeHidden: boolean,
): Promise<PathEntry[]> {
  const cacheKey = `${dirPath}\0${includeHidden ? '1' : '0'}`
  const cached = pathCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  try {
    const dirents = await readdir(dirPath, { withFileTypes: true })
    const entries: PathEntry[] = []
    for (const dirent of dirents) {
      if (!includeHidden && dirent.name.startsWith('.')) continue
      entries.push({
        name: dirent.name,
        path: join(dirPath, dirent.name),
        kind: dirent.isDirectory() ? 'directory' : 'file',
      })
      if (entries.length >= SCAN_CAP) break
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    pathCache.set(cacheKey, entries)
    return entries
  } catch (error) {
    logForDebugging(`directoryCompletion: failed to read ${dirPath}: ${String(error)}`)
    return []
  }
}

export async function getPathCompletions(
  partialPath: string,
  options?: PathCompletionOptions,
): Promise<PathSuggestionItem[]> {
  const basePath = options?.basePath ?? getCwd()
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS
  const directoriesOnly = options?.directoriesOnly ?? false
  const { rawDir, displayPrefix, namePrefix } = splitPartialPath(partialPath)
  const includeHidden = (options?.includeHidden ?? false) || namePrefix.startsWith('.')

  let resolvedDir: string
  try {
    const normalizedRawDir = rawDir.startsWith('~\\') ? rawDir.replace(/\\/g, '/') : rawDir
    resolvedDir = expandPath(normalizedRawDir, basePath)
  } catch (error) {
    logForDebugging(`directoryCompletion: failed to expand ${partialPath}: ${String(error)}`)
    return []
  }

  const entries = await listDirectoryEntries(resolvedDir, includeHidden)
  const lowerPrefix = namePrefix.toLowerCase()
  const results: PathSuggestionItem[] = []
  for (const entry of entries) {
    if (directoriesOnly && entry.kind !== 'directory') continue
    if (!entry.name.toLowerCase().startsWith(lowerPrefix)) continue
    const suffix = entry.kind === 'directory' ? '/' : ''
    const completed = `${displayPrefix}${entry.name}${suffix}`
    results.push({
      id: completed,
      displayText: completed,
      description: entry.kind === 'directory' ? 'directory' : undefined,
      metadata: entry,
    })
    if (results.length >= maxResults) break
  }
  return results
}

export function isPathLikeToken(token: string): boolean {
  if (!token) return false
  if (
    token.startsWith('/') ||
    token.startsWith('./') ||
    token.startsWith('.\\') ||
    token.startsWith('../') ||
    token.startsWith('..\\') ||
    token.startsWith('~/') ||
    token.startsWith('~\\') ||
    token === '~' ||
    token.startsWith('\\\\')
  ) {
    return true
  }
  return /^[A-Za-z]:[/\\]/.test(token)
}
