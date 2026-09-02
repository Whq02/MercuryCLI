// The project file index: build (git ls-files or a walk fallback),
// background untracked merge, ignore overlays, directory synthesis,
// signature-based rebuild avoidance, a 5 s refresh throttle keyed on the
// repository index mtime, generation-guarded continuations, progressive
// queryability with a completion signal, and the 15-cap fuzzy query.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep, dirname, isAbsolute, resolve } from 'node:path'
import { FileIndex, yieldToEventLoop } from '../native-ts/file-index/index.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { ripgrepCommand } from '../utils/ripgrep.js'
import { findGitRoot } from '../utils/git.js'
import { getCwd } from '../utils/cwd.js'
import { getCurrentProjectConfig, getGlobalConfig } from '../utils/config.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'
import { createBaseHookInput } from '../utils/hooks/execution.js'
import { executeFileSuggestionCommand } from '../utils/hooks/events.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'

const RESULT_CAP = 15
const GIT_TRACKED_TIMEOUT_MS = 5000
const GIT_UNTRACKED_TIMEOUT_MS = 10_000
const WALK_TIMEOUT_MS = 10_000
const REFRESH_FLOOR_MS = 5000
const SIGNATURE_SAMPLES = 500

// ── the separator law ───────────────────────────────────────────────────────
// The index holds ONE canonical spelling — forward slashes — on every
// platform; every source normalises at ingestion and every query normalises
// before the search, so `src\ut` and `src/ut` both match on Windows. The
// display layer converts back to the platform's own separator at the edge.
// POSIX paths pass through untouched (a backslash is a legal byte there).

/** Ingestion/query spelling: platform separators fold to '/'. Pure — the
 *  separator is injectable for the win32 unit pins. */
export function canonicalizeSuggestionPath(path: string, separator: string = sep): string {
  return separator === '\\' ? path.replaceAll('\\', '/') : path
}

/** Display spelling: the platform's own separator. Pure — injectable for
 *  the win32 unit pins. */
export function displaySuggestionPath(path: string, separator: string = sep): string {
  return separator === '\\' ? path.replaceAll('/', '\\') : path
}

// ── process-wide state ──────────────────────────────────────────────────────
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
/** The project this index belongs to (config home + cwd). One process can
 *  host several projects over its life; a key change resets the whole cache
 *  so one project's paths never surface in another. */
let indexKey: string | null = null

/** The per-project cache key: config home + cwd, the two facts that decide
 *  what the index may contain. */
export function fileSuggestionIndexKey(): string {
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

/** ~500 evenly strided samples + the length, always including the first
 *  and last path so a tail append/removal is detected. */
export function pathListSignature(paths: string[]): string {
  const parts: string[] = [String(paths.length)]
  if (paths.length > 0) {
    const stride = Math.max(1, Math.floor(paths.length / SIGNATURE_SAMPLES))
    for (let i = 0; i < paths.length; i += stride) parts.push(paths[i] as string)
    parts.push(paths[0] as string, paths[paths.length - 1] as string)
  }
  return parts.join('\u0000')
}

// ── ignore overlays (.ignore / .rgignore — the search-tool contract) ────────
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
  } catch {
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
      } catch {
        /* unreadable overlays are absent, not errors */
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

// ── sources ─────────────────────────────────────────────────────────────────
function respectGitignore(): boolean {
  const project = getCurrentProjectConfig() as { respectGitignore?: boolean }
  if (typeof project.respectGitignore === 'boolean') return project.respectGitignore
  const global = getGlobalConfig().respectGitignore
  if (typeof global === 'boolean') return global
  return true
}

async function listTracked(
  gitRoot: string,
  signal: AbortSignal,
): Promise<string[] | null> {
  const outcome = await execFileNoThrowWithCwd(
    'git',
    ['-c', 'core.quotepath=false', 'ls-files', '--recurse-submodules'],
    { cwd: gitRoot, timeout: GIT_TRACKED_TIMEOUT_MS, abortSignal: signal, maxBuffer: 64 * 1024 * 1024 },
  )
  if (outcome.code !== 0) return null
  return outcome.stdout.split('\n').filter(line => line !== '')
}

async function listUntracked(gitRoot: string): Promise<string[]> {
  const args = ['-c', 'core.quotepath=false', 'ls-files', '--others']
  if (respectGitignore()) args.push('--exclude-standard')
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
  if (!respectGitignore()) args.push('--no-ignore-vcs')
  const outcome = await execFileNoThrowWithCwd(rgPath, args, {
    cwd,
    timeout: WALK_TIMEOUT_MS,
    abortSignal: signal,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (outcome.code !== 0) return []
  // rg emits platform separators; the index holds the canonical spelling.
  return outcome.stdout
    .split('\n')
    .filter(line => line !== '')
    .map(line => canonicalizeSuggestionPath(line))
}

function relativise(paths: string[], base: string, cwd: string): string[] {
  if (base === cwd) return paths
  // Canonical spellings on both sides: gitRoot/cwd carry the platform
  // separator while git's paths carry '/'.
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

/** Markdown files under the harness configuration subdirectories. */
function configFiles(): string[] {
  const out: string[] = []
  const home = getMercuryHome()
  for (const sub of ['commands', 'agents', 'skills']) {
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
    } catch {
      /* absent config homes are fine */
    }
  }
  return out
}

import { readdirSync, type Dirent } from 'node:fs'
function readdirSyncSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// ── directory synthesis ─────────────────────────────────────────────────────
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

export function getDirectoryNamesAsync(files: string[]): Promise<string[]> {
  return (async () => {
    const out = new Set<string>()
    let iterations = 0
    let sliceStart = Date.now()
    for (const file of files) {
      let parent = dirname(file)
      while (parent !== '.' && parent !== dirname(parent) && !out.has(parent + '/')) {
        out.add(parent + '/')
        parent = dirname(parent)
      }
      // Time-budgeted yield, checked every 256 iterations to stay cheap.
      if ((++iterations & 255) === 0 && Date.now() - sliceStart > 8) {
        await yieldToEventLoop()
        sliceStart = Date.now()
      }
    }
    return [...out]
  })()
}

// ── build + refresh ─────────────────────────────────────────────────────────
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
    // Overwriting the merged index with tracked-only data must clear the
    // merged signature, or a later merged load never rebuilds.
    mergedSignature = null
  }
  void queryable.then(() => emitBuildComplete())
}

/** The repository's REAL git directory: `.git` is a directory at a main
 *  worktree, and a FILE at a linked worktree or submodule whose one
 *  `gitdir: <path>` line points at it (relative paths resolve against the
 *  root). A linked worktree's index is per-worktree and lives THERE — the
 *  old `<root>/.git/index` stat threw on the file and read every linked
 *  worktree as index-less forever. Exported for
 *  prove-suggestion-platform-and-project. */
export function resolveGitDir(gitRoot: string): string | null {
  const dotGit = join(gitRoot, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
    if (m === null) return null
    const target = m[1] as string
    return isAbsolute(target) ? target : resolve(gitRoot, target)
  } catch {
    return null
  }
}

function repositoryIndexMtime(gitRoot: string | null): number | null {
  if (gitRoot === null) return null
  const gitDir = resolveGitDir(gitRoot)
  if (gitDir === null) return null
  try {
    return statSync(join(gitDir, 'index')).mtimeMs
  } catch {
    // No index yet (a fresh init), outside a repository.
    return null
  }
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return
  // Project switch (cwd or config home changed under this process): the
  // whole cache resets BEFORE any throttle gate — one project's paths never
  // wait out a floor to stop leaking into another.
  const keyAtStart = fileSuggestionIndexKey()
  if (indexKey !== null && indexKey !== keyAtStart) {
    clearFileSuggestionCaches()
  }
  const cwd = getCwd()
  const gitRoot = findGitRoot(cwd)
  const now = Date.now()
  let indexUnchanged = false
  if (index !== null) {
    const mtime = repositoryIndexMtime(gitRoot)
    const mtimeChanged = mtime !== null && mtime !== lastIndexMtimeMs
    if (!mtimeChanged && now - lastRefreshAt < REFRESH_FLOOR_MS) return
    // Past the floor with a LIVE unmoved index reading: git ls-files reads
    // the index, so an identical index is an identical tracked set — the
    // subprocess walk is skipped below and only the untracked merge
    // refreshes (untracked churn never moves the index).
    indexUnchanged = mtime !== null && !mtimeChanged && trackedOnly !== null
  }
  refreshInFlight = true
  const startGeneration = generation
  const abort = new AbortController()
  // The walk deadline is disarmed in finally — an early return or a throw
  // never leaves it armed.
  const timer = setTimeout(() => abort.abort(), WALK_TIMEOUT_MS)
  try {
    let paths: string[]
    if (gitRoot !== null && indexUnchanged) {
      // The tracked ls-files is skipped (the index stood still); freshly
      // created files keep appearing through the merge at the floor's own
      // cadence.
      kickUntrackedMerge(gitRoot, cwd, startGeneration, keyAtStart)
      lastRefreshAt = Date.now()
      return
    }
    if (gitRoot !== null) {
      const tracked = await listTracked(gitRoot, abort.signal)
      if (generation !== startGeneration) return
      if (tracked !== null) {
        const matcher = ignoreMatcher(gitRoot, cwd)
        let relative = relativise(tracked, gitRoot, cwd)
        if (matcher !== null) relative = relative.filter(path => !matcher(path))
        paths = relative
        trackedOnly = relative
        kickUntrackedMerge(gitRoot, cwd, startGeneration, keyAtStart)
      } else {
        paths = await walkFiles(cwd, abort.signal)
        trackedOnly = null
      }
    } else {
      paths = await walkFiles(cwd, abort.signal)
      trackedOnly = null
    }
    if (generation !== startGeneration) return
    buildIndexFrom(paths, false, keyAtStart)
    lastRefreshAt = Date.now()
    // Committed only on SUCCESS so a mid-refresh change lands next call.
    lastIndexMtimeMs = repositoryIndexMtime(gitRoot)
  } catch (error) {
    logForDebugging(`file-suggestion refresh failed: ${error}`)
  } finally {
    clearTimeout(timer)
    refreshInFlight = false
  }
}

function kickUntrackedMerge(
  gitRoot: string,
  cwd: string,
  startGeneration: number,
  keyAtStart: string,
): void {
  if (untrackedInFlight) return
  untrackedInFlight = true
  void listUntracked(gitRoot)
    .then(untracked => {
      if (generation !== startGeneration) return
      if (index === null) return
      if (trackedOnly === null) return
      // Normalise BEFORE filtering so both lists filter consistently.
      let relative = untracked.length > 0 ? relativise(untracked, gitRoot, cwd) : []
      if (relative.length > 0) {
        const matcher = ignoreMatcher(gitRoot, cwd)
        if (matcher !== null) relative = relative.filter(path => !matcher(path))
      }
      if (relative.length === 0) {
        // Nothing untracked (left). A standing MERGED index would keep a
        // deleted untracked file alive on the ls-files-skip road — re-true
        // it to the tracked list; a tracked-only index stands as-is.
        if (mergedSignature !== null) buildIndexFrom([...trackedOnly], false, keyAtStart)
        return
      }
      buildIndexFrom([...trackedOnly, ...relative], true, keyAtStart)
    })
    .catch(error => logForDebugging(`untracked merge failed: ${error}`))
    .finally(() => {
      untrackedInFlight = false
    })
}

export function startBackgroundCacheRefresh(): void {
  void refresh()
}

// ── query ───────────────────────────────────────────────────────────────────
function topLevelListing(): SuggestionItem[] {
  const seen = new Set<string>()
  const out: SuggestionItem[] = []
  for (const file of indexedFiles) {
    const slash = file.indexOf('/')
    const top = slash === -1 ? file : file.slice(0, slash + 1)
    if (seen.has(top)) continue
    seen.add(top)
    out.push({ id: `file-${top}`, displayText: displaySuggestionPath(top) })
    if (out.length >= RESULT_CAP) break
  }
  return out
}

export async function generateFileSuggestions(
  partialPath: string,
  showOnEmpty = false,
): Promise<SuggestionItem[]> {
  try {
    if (partialPath === '' && !showOnEmpty) return []

    // A configured custom file-suggestion command owns the results — the
    // named owner (executeFileSuggestionCommand) reads the config, runs the
    // hook with the standard input augmented with `query`, and returns
    // pre-ranked paths; no index/config files are mixed in.
    const custom = (getInitialSettings() as {
      fileSuggestion?: { type?: string }
    }).fileSuggestion
    if (custom?.type === 'command') {
      const paths = await executeFileSuggestionCommand({
        ...createBaseHookInput(),
        query: partialPath,
      })
      return paths
        .slice(0, RESULT_CAP)
        .map(path => ({ id: `file-${path}`, displayText: path }))
    }

    // A key mismatch means the live index belongs to ANOTHER project
    // (cwd or config home moved): kick the rebuild and answer empty —
    // never another project's paths.
    const staleProject = index !== null && indexKey !== null && indexKey !== fileSuggestionIndexKey()

    if (partialPath === '' || partialPath === '.' || partialPath === './' || partialPath === '.\\') {
      startBackgroundCacheRefresh()
      return staleProject ? [] : topLevelListing()
    }

    startBackgroundCacheRefresh()
    if (staleProject) return []
    // Both separators are understood: the query folds to the index's
    // canonical '/' spelling before the search.
    let query = canonicalizeSuggestionPath(partialPath)
    if (query.startsWith('./')) query = query.slice(2)
    if (query.startsWith('~')) query = canonicalizeSuggestionPath(join(homedir(), query.slice(1)))
    if (index === null) return []
    return index
      .search(query, RESULT_CAP)
      .map(result => ({
        id: `file-${result.path}`,
        displayText: displaySuggestionPath(result.path),
        metadata: { score: result.score },
      }))
  } catch (error) {
    logForDebugging(`file suggestions failed: ${error}`)
    return []
  }
}

// ── completion appliers ─────────────────────────────────────────────────────
export function applyFileSuggestion(
  suggestion: string | SuggestionItem,
  input: string,
  partialPath: string,
  startPos: number,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
): void {
  const text =
    typeof suggestion === 'string' ? suggestion : suggestion.displayText
  const next =
    input.slice(0, startPos) + text + input.slice(startPos + partialPath.length)
  onInputChange(next)
  setCursorOffset(startPos + text.length)
}

export function findLongestCommonPrefix(
  suggestions: SuggestionItem[],
): string {
  if (suggestions.length === 0) return ''
  let prefix = suggestions[0]!.displayText
  for (const item of suggestions.slice(1)) {
    let at = 0
    const text = item.displayText
    while (at < prefix.length && at < text.length && prefix[at] === text[at]) at++
    prefix = prefix.slice(0, at)
    if (prefix === '') return ''
  }
  return prefix
}
