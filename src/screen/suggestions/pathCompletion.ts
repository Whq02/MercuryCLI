import { readdir } from 'node:fs/promises'
import { sep } from 'node:path'

import { LRUCache } from 'lru-cache'

import { getCwd } from '../../platform/files/cwd.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { expandPath } from '../../platform/files/path.js'

type PathEntry = {
  name: string
  kind: 'file' | 'directory'
}

type PathCompletionOptions = {
  basePath?: string
  maxResults?: number
}

type PathSuggestionItem = {
  id: string
  displayText: string
  metadata?: unknown
}
const SCAN_CAP = 100
const DEFAULT_MAX_RESULTS = 10
const CACHE_TTL_MS = 5 * 60 * 1000

const pathCache = new LRUCache<string, PathEntry[]>({ max: 500, ttl: CACHE_TTL_MS })

function splitPartialPath(partialPath: string): { prefix: string; namePrefix: string } {
  if (partialPath === '~') {
    return { prefix: '~/', namePrefix: '' }
  }
  const lastSep = Math.max(
    partialPath.lastIndexOf('/'),
    sep === '/' ? -1 : partialPath.lastIndexOf(sep),
  )
  return { prefix: partialPath.slice(0, lastSep + 1), namePrefix: partialPath.slice(lastSep + 1) }
}

async function listDirectoryEntries(dirPath: string): Promise<PathEntry[]> {
  const cached = pathCache.get(dirPath)
  if (cached !== undefined) {
    return cached
  }
  try {
    const dirents = await readdir(dirPath, { withFileTypes: true })
    const entries: PathEntry[] = []
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue
      entries.push({ name: dirent.name, kind: dirent.isDirectory() ? 'directory' : 'file' })
      if (entries.length >= SCAN_CAP) break
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    pathCache.set(dirPath, entries)
    return entries
  } catch (error) {
    logForDebugging(`path scan failed for ${dirPath}: ${String(error)}`)
    return []
  }
}

export async function getPathCompletions(
  partialPath: string,
  options?: PathCompletionOptions,
): Promise<PathSuggestionItem[]> {
  const basePath = options?.basePath ?? getCwd()
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS
  const { prefix, namePrefix } = splitPartialPath(partialPath)

  let resolvedDir: string
  try {
    const normalizedRawDir = prefix.startsWith('~\\') ? prefix.replace(/\\/g, '/') : prefix
    resolvedDir = expandPath(normalizedRawDir, basePath)
  } catch (error) {
    logForDebugging(`path scan failed for ${partialPath}: ${String(error)}`)
    return []
  }

  const entries = await listDirectoryEntries(resolvedDir)
  const lowerPrefix = namePrefix.toLowerCase()
  const matched = entries
    .filter(entry => entry.name.toLowerCase().startsWith(lowerPrefix))
    .slice(0, Math.max(0, maxResults))

  return matched.map(entry => {
    const reconstructed = `${prefix}${entry.name}`
    const shown = entry.kind === 'directory' ? `${reconstructed}/` : reconstructed
    return {
      id: shown,
      displayText: shown,
      metadata: entry.kind,
    }
  })
}

export function isPathLikeToken(token: string): boolean {
  if (!token) return false
  if (
    token === '~' ||
    token === '.' ||
    token === '..' ||
    token.startsWith('/') ||
    token.startsWith('./') ||
    token.startsWith('.\\') ||
    token.startsWith('../') ||
    token.startsWith('..\\') ||
    token.startsWith('~/') ||
    token.startsWith('~\\') ||
    token.startsWith('\\\\')
  ) {
    return true
  }
  return /^[A-Za-z]:[/\\]/.test(token)
}
