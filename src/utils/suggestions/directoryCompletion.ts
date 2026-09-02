import { readdir } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

import { LRUCache } from 'lru-cache'

import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { expandPath } from '../path.js'


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

  const lastSlash = Math.max(partialPath.lastIndexOf('/'), partialPath.lastIndexOf(sep))
  const visiblePrefix = lastSlash === -1 ? '' : partialPath.slice(0, lastSlash + 1)

  return entries
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

export function isPathLikeToken(token: string): boolean {
  if (token.startsWith('~/') || token.startsWith('/') || token.startsWith('./') || token.startsWith('../')) {
    return true
  }
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
