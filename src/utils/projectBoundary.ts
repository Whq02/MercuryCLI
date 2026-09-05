import { readdirSync, realpathSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { findGitRoot } from './git.js'

export const PROJECT_ENTRY_CEILING = 20_000

export const PROJECT_MARKER_NAMES: readonly string[] = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'Makefile',
  'CMakeLists.txt',
  'src',
]
const PROJECT_MARKER_EXTENSIONS: readonly string[] = ['.sln', '.csproj']

export const USER_ROOT_NAMES: readonly string[] = [
  'Desktop',
  'Documents',
  'Downloads',
  'Pictures',
  'Music',
  'Videos',
  'Movies',
  'Public',
  'Templates',
  'Library',
  'AppData',
  'Applications',
  'iCloud Drive',
]
const ONEDRIVE_PREFIX = 'onedrive'
const ONEDRIVE_REDIRECTED: readonly string[] = ['Desktop', 'Documents', 'Pictures']

function realOrSelf(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

function sameFolder(a: string, b: string): boolean {
  const x = realOrSelf(a)
  const y = realOrSelf(b)
  if (x === y) return true
  return process.platform === 'win32' && x.toLowerCase() === y.toLowerCase()
}

function nameMatches(name: string, list: readonly string[]): boolean {
  const lower = name.toLowerCase()
  return list.some(n => n.toLowerCase() === lower)
}

function rawHome(): string {
  const named = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME
  return named !== undefined && named !== '' ? named : homedir()
}

export function homeDirectory(): string {
  return realOrSelf(rawHome())
}

export function isFilesystemRoot(dir: string): boolean {
  const r = realOrSelf(dir)
  return dirname(r) === r
}

export function isHomeDirectory(dir: string): boolean {
  return sameFolder(dir, rawHome())
}

export function isWellKnownUserRoot(dir: string): boolean {
  const r = realOrSelf(dir)
  const parent = dirname(r)
  if (parent === r) return false
  const name = basename(r)
  if (sameFolder(parent, rawHome())) {
    return nameMatches(name, USER_ROOT_NAMES) || name.toLowerCase().startsWith(ONEDRIVE_PREFIX)
  }
  const grand = dirname(parent)
  if (grand !== parent && sameFolder(grand, rawHome())) {
    return basename(parent).toLowerCase().startsWith(ONEDRIVE_PREFIX) && nameMatches(name, ONEDRIVE_REDIRECTED)
  }
  return false
}

export type NonProjectRootKind = 'home' | 'filesystem-root' | 'user-root'

export function nonProjectRootKindOf(dir: string): NonProjectRootKind | null {
  if (isHomeDirectory(dir)) return 'home'
  if (isFilesystemRoot(dir)) return 'filesystem-root'
  if (isWellKnownUserRoot(dir)) return 'user-root'
  return null
}

export function projectMarkerOf(dir: string): string | null {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const marker of PROJECT_MARKER_NAMES) {
    if (names.includes(marker)) return marker
  }
  const byExtension = names.find(n => PROJECT_MARKER_EXTENSIONS.some(ext => n.toLowerCase().endsWith(ext)))
  return byExtension ?? null
}

export interface EntryCount {
  count: number
  ceilingReached: boolean
}

export function countEntriesBounded(dir: string, ceiling: number = PROJECT_ENTRY_CEILING): EntryCount {
  let count = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      count++
      if (count > ceiling) return { count, ceilingReached: true }
      if (entry.isDirectory()) stack.push(resolve(current, entry.name))
    }
  }
  return { count, ceilingReached: false }
}

export function entryCountWords(c: EntryCount): string {
  if (c.ceilingReached) return `over ${(c.count - 1).toLocaleString('en-US')} entries`
  return `${c.count.toLocaleString('en-US')} ${c.count === 1 ? 'entry' : 'entries'}`
}

export type GitInitRefusalKind = NonProjectRootKind | 'not-a-project'

export interface GitInitRefusal {
  kind: GitInitRefusalKind
  words: string
}

export function gitInitRefusal(folder: string): GitInitRefusal | null {
  const now = Date.now()
  const memo = refusalMemo.get(folder)
  if (memo !== undefined && now - memo.at < REFUSAL_MEMO_MS) return memo.value
  const value = computeGitInitRefusal(folder)
  refusalMemo.set(folder, { at: now, value })
  if (refusalMemo.size > 64) refusalMemo.delete(refusalMemo.keys().next().value as string)
  return value
}

const REFUSAL_MEMO_MS = 10_000
const refusalMemo = new Map<string, { at: number; value: GitInitRefusal | null }>()

function computeGitInitRefusal(folder: string): GitInitRefusal | null {
  const root = nonProjectRootKindOf(folder)
  if (root === 'home') return { kind: root, words: 'this is your home folder' }
  if (root === 'filesystem-root') return { kind: root, words: 'this is a drive root' }
  if (root === 'user-root') return { kind: root, words: `this is your ${basename(realOrSelf(folder))} folder (a well-known user folder, never a project)` }
  if (projectMarkerOf(folder) !== null) return null
  const entries = countEntriesBounded(folder)
  if (!entries.ceilingReached) return null
  return {
    kind: 'not-a-project',
    words: `this does not look like a project: ${entryCountWords(entries)}, no project files (no .git, package.json, pyproject.toml, Cargo.toml, go.mod, .sln, Makefile, CMakeLists.txt or src)`,
  }
}

export function projectBoundaryOf(cwd: string): string {
  const root = findGitRoot(cwd)
  if (root === null) return resolve(cwd)
  return nonProjectRootKindOf(root) !== null ? resolve(cwd) : root
}

export function launchFolderBoundsProject(cwd: string): boolean {
  const root = findGitRoot(cwd)
  return root !== null && nonProjectRootKindOf(root) !== null
}

export function projectScopePathspec(cwd: string): string[] {
  return launchFolderBoundsProject(cwd) ? ['--', '.'] : []
}
