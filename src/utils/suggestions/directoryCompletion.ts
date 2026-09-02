import { readdir } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

import { LRUCache } from 'lru-cache'

import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { expandPath } from '../path.js'

/**
 * Directory/path completion with LRU caching. The Windows drive/UNC
 * recognition keeps path typeahead alive for absolute Windows paths.
 */

export type DirectoryEntry = {
  name: string
  path: string
}

export type PathEntry = {
  name: string
  path: string
  kind: 'file' | 'directory'
}

export type CompletionOptions = {
  basePath?: string
  maxResults?: number
}

export type PathCompletionOptions = CompletionOptions & {
  includeFiles?: boolean
  includeHidden?: boolean
}

export type PathSuggestionItem = {
  id: string
  displayText: string
  description?: string
  metadata?: unknown
}

const SCAN_CAP = 100
const DEFAULT_MAX_RESULTS = 10
const CACHE_TTL_MS = 5 * 60 * 1000

const directoryCache = new LRUCache<string, DirectoryEntry[]>({ max: 500, ttl: CACHE_TTL_MS })
const pathCache = new LRUCache<string, PathEntry[]>({ max: 500, ttl: CACHE_TTL_MS })

/**
 * Empty input means "the base path (or cwd), no prefix". A raw input
 * ending in a separator is itself the directory; otherwise the directory
 * is the expanded path's parent, and the prefix is the last segment OF THE
 * RAW input, not the expanded path.
 */
export function parsePartialPath(partialPath: string, basePath?: string): { directory: string; prefix: string } {
  const base = basePath ?? getCwd()
  if (partialPath === '') {
    return { directory: base, prefix: '' }
  }
  const expanded = expandPath(partialPath, base)
  if (partialPath.endsWith('/') || partialPath.endsWith(sep)) {
    return { directory: expanded, prefix: '' }
  }
  const lastSlash = Math.max(partialPath.lastIndexOf('/'), partialPath.lastIndexOf(sep))
  const prefix = lastSlash === -1 ? partialPath : partialPath.slice(lastSlash + 1)
  return { directory: dirname(expanded), prefix }
}

/** Subdirectories, dotted names excluded, capped at 100 and cached. */
export async function scanDirectory(dirPath: string): Promise<DirectoryEntry[]> {
  const cached = directoryCache.get(dirPath)
  if (cached !== undefined) return cached
  let entries: DirectoryEntry[] = []
  try {
    const listing = await readdir(dirPath, { withFileTypes: true })
    entries = listing
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .slice(0, SCAN_CAP)
      .map(entry => ({ name: entry.name, path: join(dirPath, entry.name) }))
  } catch (error) {
    logForDebugging(`directory scan failed for ${dirPath}: ${String(error)}`)
    entries = []
  }
  directoryCache.set(dirPath, entries)
  return entries
}

/** Files and directories, directories first then alphabetical, hidden entries opt-in (and part of the cache key). */
export async function scanDirectoryForPaths(dirPath: string, includeHidden: boolean = false): Promise<PathEntry[]> {
  const cacheKey = `${dirPath}|${includeHidden ? 'hidden' : 'visible'}`
  const cached = pathCache.get(cacheKey)
  if (cached !== undefined) return cached
  let entries: PathEntry[] = []
  try {
    const listing = await readdir(dirPath, { withFileTypes: true })
    entries = listing
      .filter(entry => includeHidden || !entry.name.startsWith('.'))
      .filter(entry => entry.isFile() || entry.isDirectory())
      .map(entry => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .slice(0, SCAN_CAP)
  } catch (error) {
    logForDebugging(`path scan failed for ${dirPath}: ${String(error)}`)
    entries = []
  }
  pathCache.set(cacheKey, entries)
  return entries
}

export async function getDirectoryCompletions(
  partialPath: string,
  options?: CompletionOptions,
): Promise<PathSuggestionItem[]> {
  const { directory, prefix } = parsePartialPath(partialPath, options?.basePath)
  const entries = await scanDirectory(directory)
  const lowered = prefix.toLowerCase()
  return entries
    .filter(entry => entry.name.toLowerCase().startsWith(lowered))
    .slice(0, options?.maxResults ?? DEFAULT_MAX_RESULTS)
    .map(entry => ({
      id: entry.path,
      displayText: `${entry.name}/`,
      description: 'directory',
    }))
}

export async function getPathCompletions(
  partialPath: string,
  options?: PathCompletionOptions,
): Promise<PathSuggestionItem[]> {
  const { directory, prefix } = parsePartialPath(partialPath, options?.basePath)
  const entries = await scanDirectoryForPaths(directory, options?.includeHidden ?? false)
  const includeFiles = options?.includeFiles ?? true
  const lowered = prefix.toLowerCase()

  // Reconstruct the user-visible relative form: the portion of the raw
  // input up to and including its last separator, VERBATIM — a typed `./`
  // survives the completion (sweep #2, packet 33): in a shell line
  // `./script.sh` runs and `script.sh` does not, so the prefix is meaning,
  // not decoration.
  const lastSlash = Math.max(partialPath.lastIndexOf('/'), partialPath.lastIndexOf(sep))
  const visiblePrefix = lastSlash === -1 ? '' : partialPath.slice(0, lastSlash + 1)

  return entries
    // Filtering an already-scanned listing: the two option settings share
    // one cache entry.
    .filter(entry => includeFiles || entry.kind === 'directory')
    .filter(entry => entry.name.toLowerCase().startsWith(lowered))
    .slice(0, options?.maxResults ?? DEFAULT_MAX_RESULTS)
    .map(entry => {
      const reconstructed = `${visiblePrefix}${entry.name}`
      return {
        id: reconstructed,
        displayText: entry.kind === 'directory' ? `${reconstructed}/` : reconstructed,
        metadata: entry.kind,
      }
    })
}

/**
 * Path-like: `~/`, `/`, `./`, `../` prefixes in either separator spelling;
 * exactly `~`, `.`, `..`; a Windows drive prefix (letter, colon, slash of
 * either kind); or a UNC prefix.
 */
export function isPathLikeToken(token: string): boolean {
  if (token.startsWith('~/') || token.startsWith('/') || token.startsWith('./') || token.startsWith('../')) {
    return true
  }
  // The Windows relative spellings are paths too: `.\build`, `..\lib`, `~\x`.
  if (token.startsWith('.\\') || token.startsWith('..\\') || token.startsWith('~\\')) return true
  if (token === '~' || token === '.' || token === '..') return true
  if (/^[A-Za-z]:[/\\]/.test(token)) return true
  if (token.startsWith('\\\\')) return true
  return false
}

export function clearDirectoryCache(): void {
  directoryCache.clear()
}

export function clearPathCache(): void {
  directoryCache.clear()
  pathCache.clear()
}
