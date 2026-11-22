import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep, dirname, isAbsolute, relative, resolve } from 'node:path'
import { FileIndex } from '../native-ts/file-index/index.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { ripgrepCommand } from '../utils/ripgrep.js'
import { findGitRoot } from '../utils/git.js'
import { launchFolderBoundsProject } from '../utils/projectBoundary.js'
import { getCwd } from '../utils/cwd.js'
import { getInitialSettings, getSettingsForSource } from '../utils/settings/settings.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'
import type { FileSuggestionCommandInput } from '../types/fileSuggestion.js'
import { startCommandHook } from '../utils/hooks/commandRunner.js'
import { getSessionId } from '../bootstrap/state.js'
import { getTranscriptPathForSession } from '../utils/sessionStorage/paths.js'
import { hooksDisabled, managedHooksOnly } from '../utils/hooks/hooksConfigSnapshot.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'

const RESULT_CAP = 15
const GIT_TRACKED_TIMEOUT_MS = 5000
const GIT_UNTRACKED_TIMEOUT_MS = 10_000
const WALK_TIMEOUT_MS = 10_000
const REFRESH_FLOOR_MS = 5000
const SIGNATURE_SAMPLES = 500


export function canonicalizeSuggestionPath(path: string, separator: string = sep): string {
  return separator === '\\' ? path.replaceAll('\\', '/') : path
}

export function displaySuggestionPath(path: string, separator: string = sep): string {
  return separator === '\\' ? path.replaceAll('/', '\\') : path
}

let index: FileIndex | null = unbuilt('src/hooks/fileSuggestions.ts:37')
let indexedFiles: string[] = unbuilt('src/hooks/fileSuggestions.ts:38')
let trackedOnly: string[] | null = unbuilt('src/hooks/fileSuggestions.ts:39')
let trackedSignature: string | null = unbuilt('src/hooks/fileSuggestions.ts:40')
let mergedSignature: string | null = unbuilt('src/hooks/fileSuggestions.ts:41')
let generation = 0
let refreshInFlight = false
let untrackedInFlight = false
let lastRefreshAt = 0
let lastIndexMtimeMs: number | null = null
let indexKey: string | null = null

function fileSuggestionIndexKey(): string {
  return `${getMercuryHome()}\u0000${getCwd()}`
}
const buildCompleteListeners = new Set<() => void>()
let ignoreCache: {
  key: string
  matcher: ((path: string) => boolean) | null
} | null = null

export function onIndexBuildComplete(listener: () => void): () => void {
  buildCompleteListeners.add(listener)
  return () => buildCompleteListeners.delete(listener)
}

function emitBuildComplete(): void {
  for (const listener of buildCompleteListeners) listener()
}

export function clearFileSuggestionCaches(): void {
  index = null
  indexedFiles = []
  trackedOnly = null
  trackedSignature = null
  mergedSignature = null
  refreshInFlight = false
  untrackedInFlight = false
  lastRefreshAt = 0
  lastIndexMtimeMs = null
  ignoreCache = null
  indexKey = null
  generation++
}

function pathListSignature(paths: string[]): string {
  const parts: string[] = [String(paths.length)]
  if (paths.length > 0) {
    const stride = Math.max(1, Math.floor(paths.length / SIGNATURE_SAMPLES))
    for (let i = 0; i < paths.length; i += stride) parts.push(paths[i] as string)
    parts.push(paths[0] as string, paths[paths.length - 1] as string)
  }
  return parts.join('\u0000')
}

function globToRegExp(pattern: string): RegExp | null {
  try {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0001')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0001/g, '.*')
      .replace(/\?/g, '[^/]')
    return new RegExp(
      pattern.startsWith('/') ? `^${escaped.slice(2)}` : `(^|/)${escaped}`,
    )
  } catch (error) {
    passedOver(error)
    return null
  }
}

function ignoreMatcher(gitRoot: string | null, cwd: string): ((path: string) => boolean) | null {
  const key = `${gitRoot ?? ''}|${cwd}`
  if (ignoreCache?.key === key) return ignoreCache.matcher
  const dirs = gitRoot !== null && gitRoot !== cwd ? [gitRoot, cwd] : [cwd]
  const patterns: RegExp[] = []
  for (const dir of dirs) {
    for (const name of ['.ignore', '.rgignore']) {
      try {
        const body = readFileSync(join(dir, name), 'utf8')
        for (const raw of body.split('\n')) {
          const line = raw.trim()
          if (line === '' || line.startsWith('#')) continue
          const re = globToRegExp(line)
          if (re !== null) patterns.push(re)
        }
      } catch (error) {
        passedOver(error)
      }
    }
  }
  const matcher =
    patterns.length === 0
      ? null
      : (path: string): boolean => patterns.some(re => re.test(path))
  ignoreCache = { key, matcher }
  return matcher
}

function honourGitignore(): boolean {
  return getInitialSettings().files?.honourGitignore !== false
}

function boundaryPathspec(gitRoot: string, cwd: string): string[] {
  if (!launchFolderBoundsProject(cwd)) return []
  const inside = relative(gitRoot, cwd)
  return inside === '' ? [] : ['--', inside]
}

async function listTracked(
  gitRoot: string,
  signal: AbortSignal,
  scope: string[],
): Promise<string[] | null> {
  const outcome = await execFileNoThrowWithCwd(
    'git',
    ['-c', 'core.quotepath=false', 'ls-files', '--recurse-submodules', ...scope],
    { cwd: gitRoot, timeout: GIT_TRACKED_TIMEOUT_MS, abortSignal: signal, maxBuffer: 64 * 1024 * 1024 },
  )
  if (outcome.code !== 0) return null
  return outcome.stdout.split('\n').filter(line => line !== '')
}

async function listUntracked(gitRoot: string, scope: string[]): Promise<string[]> {
  const args = ['-c', 'core.quotepath=false', 'ls-files', '--others']
  if (honourGitignore()) args.push('--exclude-standard')
  args.push(...scope)
  const outcome = await execFileNoThrowWithCwd('git', args, {
    cwd: gitRoot,
    timeout: GIT_UNTRACKED_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (outcome.code !== 0) return []
  return outcome.stdout.split('\n').filter(line => line !== '')
}

async function walkFiles(cwd: string, signal: AbortSignal): Promise<string[]> {
  const { rgPath, rgArgs } = ripgrepCommand()
  const args = [
    ...rgArgs,
    '--files',
    '--follow',
    '--hidden',
    ...['.git/', '.svn/', '.hg/', '.bzr/', '.jj/', '.sl/'].flatMap(dir => [
      '--glob',
      `!${dir}`,
    ]),
  ]
  if (!honourGitignore()) args.push('--no-ignore-vcs')
  const outcome = await execFileNoThrowWithCwd(rgPath, args, {
    cwd,
    timeout: WALK_TIMEOUT_MS,
    abortSignal: signal,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (outcome.code !== 0) return []
  return outcome.stdout
    .split('\n')
    .filter(line => line !== '')
    .map(line => canonicalizeSuggestionPath(line))
}

function relativise(paths: string[], base: string, cwd: string): string[] {
  if (base === cwd) return paths
  const canonicalCwd = canonicalizeSuggestionPath(cwd)
  const canonicalBase = canonicalizeSuggestionPath(base)
  const prefix = canonicalCwd.startsWith(canonicalBase)
    ? canonicalCwd.slice(canonicalBase.length).replace(/^\//, '')
    : null
  if (prefix === null) return paths
  const withSep = prefix === '' ? '' : `${prefix}/`
  return paths
    .filter(path => withSep === '' || path.startsWith(withSep))
    .map(path => path.slice(withSep.length))
}

function configFiles(): string[] {
  const out: string[] = []
  const home = getMercuryHome()
  for (const sub of ['agents', 'skills']) {
    try {
      const dir = join(home, sub)
      const walk = (at: string, depth: number): void => {
        if (depth > 3) return
        for (const entry of readdirSyncSafe(at)) {
          const full = join(at, entry.name)
          if (entry.isDirectory()) walk(full, depth + 1)
          else if (entry.name.endsWith('.md')) out.push(canonicalizeSuggestionPath(full))
        }
      }
      walk(dir, 0)
    } catch (error) {
      passedOver(error)
    }
  }
  return out
}

import { readdirSync, type Dirent } from 'node:fs'
import { passedOver } from '../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { notBuilt, unbuilt } from '../pi/holes.js'
function readdirSyncSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    passedOver(error)
    return []
  }
}

function collectDirectories(files: string[], out: Set<string>): void {
  for (const file of files) {
    let parent = dirname(file)
    while (
      parent !== '.' &&
      parent !== dirname(parent) &&
      !out.has(parent + '/')
    ) {
      out.add(parent + '/')
      parent = dirname(parent)
    }
  }
}

function buildIndexFrom(paths: string[], merged: boolean, keyAtStart: string): void {
  const signature = pathListSignature(paths)
  if (merged) {
    if (mergedSignature === signature) return
  } else if (trackedSignature === signature && mergedSignature === null) {
    return
  }
  const directories = new Set<string>()
  collectDirectories(paths, directories)
  const all = [...paths, ...directories, ...configFiles()]
  const fresh = new FileIndex()
  const { queryable } = fresh.loadFromFileListAsync(all)
  index = fresh
  indexedFiles = paths
  indexKey = keyAtStart
  if (merged) {
    mergedSignature = signature
  } else {
    trackedSignature = signature
    mergedSignature = null
  }
  void queryable.then(() => emitBuildComplete())
}

export function resolveGitDir(gitRoot: string): string | null {
  const dotGit = join(gitRoot, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
    if (m === null) return null
    const target = m[1] as string
    return isAbsolute(target) ? target : resolve(gitRoot, target)
  } catch (error) {
    passedOver(error)
    return null
  }
}

function repositoryIndexMtime(gitRoot: string | null): number | null {
  if (gitRoot === null) return null
  const gitDir = resolveGitDir(gitRoot)
  if (gitDir === null) return null
  try {
    return statSync(join(gitDir, 'index')).mtimeMs
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function startBackgroundCacheRefresh(): void {
  return notBuilt('src/hooks/fileSuggestions.ts:399')
}

const FILE_SUGGESTER_TIMEOUT_MS = 5000

export async function generateFileSuggestions(
  partialPath: string,
  showOnEmpty?: boolean,
): Promise<SuggestionItem[]> {
  return notBuilt('src/hooks/fileSuggestions.ts:434')
}


export function findLongestCommonPrefix(
  suggestions: SuggestionItem[],
): string {
  return notBuilt('src/hooks/fileSuggestions.ts:476')
}
