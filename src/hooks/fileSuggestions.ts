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

let index: FileIndex | null = null
let indexedFiles: string[] = []
let trackedOnly: string[] | null = null
let trackedSignature: string | null = null
let mergedSignature: string | null = null
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

function startUntrackedMerge(
  gitRoot: string,
  cwd: string,
  scope: string[],
  gen: number,
  keyAtStart: string,
): void {
  if (untrackedInFlight) return
  untrackedInFlight = true
  void (async () => {
    try {
      const rawUntracked = await listUntracked(gitRoot, scope)
      if (gen !== generation || index === null || trackedOnly === null) return
      const canonical = rawUntracked.map(p => canonicalizeSuggestionPath(p))
      const rel = relativise(canonical, gitRoot, cwd)
      const ignored = ignoreMatcher(gitRoot, cwd)
      const surviving = ignored ? rel.filter(p => !ignored(p)) : rel
      if (surviving.length === 0) {
        if (mergedSignature !== null) {
          buildIndexFrom(trackedOnly, false, keyAtStart)
        }
        return
      }
      const seen = new Set(trackedOnly)
      const merged = [...trackedOnly]
      for (const p of surviving) {
        if (!seen.has(p)) {
          seen.add(p)
          merged.push(p)
        }
      }
      buildIndexFrom(merged, true, keyAtStart)
    } catch (error) {
      logForDebugging(`untracked merge failed: ${String(error)}`)
    } finally {
      if (gen === generation) untrackedInFlight = false
    }
  })()
}

export function startBackgroundCacheRefresh(): void {
  const key = fileSuggestionIndexKey()
  if (indexKey !== null && indexKey !== key) {
    clearFileSuggestionCaches()
  }
  if (refreshInFlight) return

  const cwd = getCwd()
  const gitRoot = findGitRoot(cwd)
  const currentMtime = repositoryIndexMtime(gitRoot)
  const now = Date.now()
  const mtimeChanged = currentMtime !== lastIndexMtimeMs

  if (index !== null && now - lastRefreshAt < REFRESH_FLOOR_MS && !mtimeChanged) {
    return
  }

  if (gitRoot !== null && !mtimeChanged && trackedOnly !== null) {
    lastRefreshAt = now
    const scope = boundaryPathspec(gitRoot, cwd)
    startUntrackedMerge(gitRoot, cwd, scope, generation, key)
    return
  }

  refreshInFlight = true
  const gen = generation
  const controller = new AbortController()
  const timer = startTimeout(() => controller.abort(), WALK_TIMEOUT_MS)

  void (async () => {
    try {
      let tracked: string[] | null = null
      const scope = gitRoot !== null ? boundaryPathspec(gitRoot, cwd) : []
      if (gitRoot !== null) {
        tracked = await listTracked(gitRoot, controller.signal, scope)
      }
      if (gen !== generation) return

      const ignored = ignoreMatcher(gitRoot, cwd)
      if (gitRoot !== null && tracked !== null) {
        const canonicalTracked = tracked.map(p => canonicalizeSuggestionPath(p))
        const relTracked = relativise(canonicalTracked, gitRoot, cwd)
        const filteredTracked = ignored
          ? relTracked.filter(p => !ignored(p))
          : relTracked
        if (gen !== generation) return
        trackedOnly = filteredTracked
        lastRefreshAt = Date.now()
        lastIndexMtimeMs = currentMtime
        buildIndexFrom(filteredTracked, false, key)
        startUntrackedMerge(gitRoot, cwd, scope, gen, key)
        return
      }

      const walked = await walkFiles(cwd, controller.signal)
      if (gen !== generation) return
      const filteredWalked = ignored ? walked.filter(p => !ignored(p)) : walked
      trackedOnly = null
      lastRefreshAt = Date.now()
      lastIndexMtimeMs = currentMtime
      buildIndexFrom(filteredWalked, false, key)
    } catch (error) {
      logForDebugging(`file-suggestion refresh failed: ${String(error)}`)
    } finally {
      stopTimeout(timer)
      if (gen === generation) refreshInFlight = false
    }
  })()
}

const FILE_SUGGESTER_TIMEOUT_MS = 5000

function activeFileSuggesterCommand(): string | null {
  if (hooksDisabled()) return null
  const suggester = managedHooksOnly()
    ? getSettingsForSource('policySettings')?.files?.suggester
    : getInitialSettings().files?.suggester
  return suggester?.type === 'command' && suggester.command
    ? suggester.command
    : null
}

export async function generateFileSuggestions(
  partialPath: string,
  showOnEmpty = false,
): Promise<SuggestionItem[]> {
  if (!partialPath && !showOnEmpty) return []

  const command = activeFileSuggesterCommand()
  if (command !== null) {
    const sessionId = getSessionId()
    const payload: FileSuggestionCommandInput = {
      session_id: sessionId,
      transcript_path: getTranscriptPathForSession(sessionId),
      cwd: getCwd(),
      query: partialPath,
    }
    try {
      const proc = await startCommandHook({
        command,
        shell: 'bash',
        name: 'files.suggester',
        event: 'files.suggester',
        index: 0,
        payloadJson: JSON.stringify(payload),
        timeoutMs: FILE_SUGGESTER_TIMEOUT_MS,
        source: { kind: 'settings' },
        cwd: payload.cwd,
      })
      const end = await proc.result
      if (end.kind !== 'exited' || end.code !== 0) {
        return []
      }
      return end.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
        .slice(0, RESULT_CAP)
        .map(path => ({
          id: `file-${path}`,
          displayText: path,
        }))
    } catch (error) {
      logForDebugging(`files.suggester failed: ${String(error)}`, { level: 'error' })
      return []
    }
  }

  try {
    const key = fileSuggestionIndexKey()
    startBackgroundCacheRefresh()
    if (index === null || indexKey !== key) return []

    if (
      partialPath === '' ||
      partialPath === '.' ||
      partialPath === './' ||
      partialPath === '.\\'
    ) {
      const seen = new Set<string>()
      const items: SuggestionItem[] = []
      for (const file of indexedFiles) {
        const slash = file.indexOf('/')
        const top = slash === -1 ? file : file.slice(0, slash + 1)
        if (seen.has(top)) continue
        seen.add(top)
        items.push({
          id: `file-${top}`,
          displayText: displaySuggestionPath(top),
        })
        if (items.length >= RESULT_CAP) break
      }
      return items
    }

    let query = canonicalizeSuggestionPath(partialPath)
    if (query.startsWith('./')) {
      query = query.slice(2)
    }
    if (query === '~' || query.startsWith('~/')) {
      query = canonicalizeSuggestionPath(homedir()) + query.slice(1)
    }
    const results = index.search(query, RESULT_CAP)
    return results.map(result => ({
      id: `file-${result.path}`,
      displayText: displaySuggestionPath(result.path),
      metadata: { score: result.score },
    }))
  } catch (error) {
    logForDebugging(`file suggestions failed: ${String(error)}`)
    return []
  }
}

export function findLongestCommonPrefix(
  suggestions: SuggestionItem[],
): string {
  if (suggestions.length === 0) return ''
  let prefix = suggestions[0]!.displayText
  for (let i = 1; i < suggestions.length; i++) {
    const text = suggestions[i]!.displayText
    let j = 0
    const limit = Math.min(prefix.length, text.length)
    while (j < limit && prefix.charCodeAt(j) === text.charCodeAt(j)) {
      j++
    }
    prefix = prefix.slice(0, j)
    if (prefix === '') return ''
  }
  return prefix
}
