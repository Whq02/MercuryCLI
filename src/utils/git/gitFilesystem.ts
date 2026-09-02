import { unwatchFile, watchFile } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { waitForScrollIdle } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { getCwd } from '../cwd.js'
import { findGitRoot } from '../git.js'
import { parseGitConfigValue } from './gitConfigParser.js'

/**
 * Filesystem-only git state — git dir, HEAD, refs, common dir — plus a
 * watch-driven cache, so hot UI surfaces (branch, HEAD sha, remote URL,
 * default branch) never spawn git.
 *
 * Format facts this file relies on, per git's own source: HEAD is either
 * `ref: refs/heads/<branch>` or a raw sha; packed refs are `<sha> <ref>`
 * lines with `#` and `^` lines skipped; a worktree's `.git` file is
 * `gitdir: <path>` with an optionally relative path; and the mere
 * existence of `shallow` in the common dir means a shallow clone.
 */

// ————— git dir resolution —————

// Stores negatives too; no invalidation beyond the test-only clear.
const gitDirCache = new Map<string, string | null>()

export function clearResolveGitDirCache(): void {
  gitDirCache.clear()
}

export async function resolveGitDir(startPath: string = getCwd()): Promise<string | null> {
  const resolvedStart = resolve(startPath)
  if (gitDirCache.has(resolvedStart)) return gitDirCache.get(resolvedStart) ?? null
  let result: string | null = null
  try {
    const root = findGitRoot(resolvedStart)
    if (!root) {
      gitDirCache.set(resolvedStart, null)
      return null
    }
    const dotGitPath = join(root, '.git')
    const dotGitStat = await stat(dotGitPath)
    if (dotGitStat.isFile()) {
      // Worktree or submodule pointer. Git strips trailing CR/LF itself.
      const content = (await readFile(dotGitPath, 'utf8')).trim()
      if (content.startsWith('gitdir:')) {
        result = resolve(root, content.slice('gitdir:'.length).trim())
        gitDirCache.set(resolvedStart, result)
        return result
      }
    }
    // Plain fallthrough, NOT a directory test: reached for a directory AND
    // for a file whose content is not a gitdir pointer — a malformed
    // pointer file caches the file path, not null.
    result = dotGitPath
  } catch {
    result = null
  }
  gitDirCache.set(resolvedStart, result)
  return result
}

// ————— name and sha safety —————

/**
 * `.git/HEAD` and loose refs are plain text an attacker can write without
 * git's own validation, and the values flow into path joins, positional
 * git arguments and shell command strings. Four rejections, then an
 * allowlist wide enough for real branch names and narrow enough to exclude
 * everything a shell or line parser cares about.
 */
export function isSafeRefName(name: string): boolean {
  if (name === '') return false
  // A leading `-` would read as an option to any git invocation.
  if (name.startsWith('-') || name.startsWith('/')) return false
  if (name.includes('..')) return false
  for (const component of name.split('/')) {
    // Covers the interior `./`, the doubled slash and the trailing slash;
    // a `.` component would be normalised away by path joining and attach
    // a watcher to the containing directory instead of a branch file.
    if (component === '.' || component === '') return false
  }
  return /^[A-Za-z0-9/._+@-]+$/.test(name)
}

/** Exactly 40 (SHA-1) or 64 (SHA-256) lowercase hex characters — git never writes abbreviated shas to HEAD or ref files. */
export function isValidGitSha(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s) || /^[0-9a-f]{64}$/.test(s)
}

// ————— HEAD / refs —————

export async function readGitHead(
  gitDir: string,
): Promise<{ type: 'branch'; name: string } | { type: 'detached'; sha: string } | null> {
  try {
    const content = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    if (content.startsWith('ref:')) {
      // Git allows any whitespace after the colon.
      const target = content.slice('ref:'.length).trim()
      if (target.startsWith('refs/heads/')) {
        const name = target.slice('refs/heads/'.length)
        return isSafeRefName(name) ? { type: 'branch', name } : null
      }
      // An unusual symref (bisect etc.): resolve it and report detached —
      // with an EMPTY string sha when resolution fails (preserved shape).
      if (!isSafeRefName(target)) return null
      const sha = await resolveRef(gitDir, target)
      return { type: 'detached', sha: sha ?? '' }
    }
    if (!isValidGitSha(content)) return null
    return { type: 'detached', sha: content }
  } catch {
    return null
  }
}

/** The path named by `<gitDir>/commondir`, resolved relative to the git dir; null for a regular repository. */
export async function getCommonDir(gitDir: string): Promise<string | null> {
  try {
    const content = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
    return resolve(gitDir, content)
  } catch {
    return null
  }
}

async function resolveRefInDir(dir: string, ref: string): Promise<string | null> {
  let looseContent: string | null = null
  try {
    looseContent = (await readFile(join(dir, ref), 'utf8')).trim()
  } catch {
    looseContent = null
  }
  if (looseContent !== null) {
    if (looseContent.startsWith('ref:')) {
      const target = looseContent.slice('ref:'.length).trim()
      if (!isSafeRefName(target)) return null
      // Recursion re-enters at the top level, so it can cross into the
      // common dir.
      return resolveRef(dir, target)
    }
    return isValidGitSha(looseContent) ? looseContent : null
  }
  // packed-refs: lines are NOT trimmed (git writes LF; CRLF never matches).
  try {
    const packed = await readFile(join(dir, 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      if (line.startsWith('#') || line.startsWith('^')) continue
      const spaceIndex = line.indexOf(' ')
      if (spaceIndex === -1) continue
      if (line.slice(spaceIndex + 1) === ref) {
        const sha = line.slice(0, spaceIndex)
        return isValidGitSha(sha) ? sha : null
      }
    }
    return null
  } catch {
    return null
  }
}

/** Resolves a ref to a commit sha; worktrees need the common-dir fallback (shared refs live there). */
export async function resolveRef(gitDir: string, ref: string): Promise<string | null> {
  const direct = await resolveRefInDir(gitDir, ref)
  if (direct !== null) return direct
  const commonDir = await getCommonDir(gitDir)
  if (commonDir !== null && commonDir !== gitDir) {
    return resolveRefInDir(commonDir, ref)
  }
  return null
}

/** Loose-file symref read only (packed-refs never stores symrefs); the remainder after the prefix, name-safety enforced. */
export async function readRawSymref(gitDir: string, refPath: string, branchPrefix: string): Promise<string | null> {
  try {
    const content = (await readFile(join(gitDir, refPath), 'utf8')).trim()
    if (!content.startsWith('ref:')) return null
    const target = content.slice('ref:'.length).trim()
    if (!target.startsWith(branchPrefix)) return null
    const name = target.slice(branchPrefix.length)
    return isSafeRefName(name) ? name : null
  } catch {
    return null
  }
}

// ————— the watching cache —————

// Resolved ONCE at module evaluation; changing NODE_ENV after import has
// no effect. The 10ms test interval is what the proofs depend on.
const POLL_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 10 : 1000

type WatchListener = (curr: unknown, prev: unknown) => void

let watcherStarted = false
let watcherStarting: Promise<void> | null = null
let generation = 0
let watchedGitDir: string | null = null
let watchedCommonDir: string | null = null
let watchedBranchRefPath: string | null = null
let cleanupRegistered = false
const watchedPaths = new Map<string, WatchListener>()
type CacheEntry = { value: unknown; dirty: boolean; inflight: Promise<unknown> | null }
const cacheEntries = new Map<string, CacheEntry>()

// persistent:false — this cache only INVALIDATES; it must never be the
// handle that keeps a process alive. A headless verb run inside a git repo
// (`mercury extensions list --json` from a checkout) armed these pollers
// through one cached branch read and then sat forever after its answer;
// the interactive boot's loop is held by its own screen, so nothing is
// lost there. Same law as the global-config freshness watcher.
function watchPath(path: string, listener: WatchListener): void {
  watchFile(path, { interval: POLL_INTERVAL_MS, persistent: false }, listener as never)
  watchedPaths.set(path, listener)
}

/** Detaches by path AND the exact listener — a path can carry more than one registration, and detaching by path alone removes someone else's. */
function unwatchPath(path: string): void {
  const listener = watchedPaths.get(path)
  if (listener !== undefined) {
    unwatchFile(path, listener as never)
    watchedPaths.delete(path)
  }
}

/** Invalidation is a flag flip only — a stale entry can still be served, so this runs FIRST and costs nothing. */
function invalidateAllEntries(): void {
  for (const entry of cacheEntries.values()) entry.dirty = true
}

/**
 * On start and on every HEAD change: recompute the branch-ref watch. An
 * early return when the target equals the current watch covers both
 * "already watching this branch" and "already watching nothing". Attaching
 * to a not-yet-existing path is intentional — the poller reports the
 * file's appearance (a new branch before its first commit).
 */
async function reattachBranchWatch(): Promise<void> {
  const startGeneration = generation
  if (watchedGitDir === null) return
  const head = await readGitHead(watchedGitDir)
  if (generation !== startGeneration) return
  const refsDir = watchedCommonDir ?? watchedGitDir
  const nextRefPath = head?.type === 'branch' ? join(refsDir, 'refs', 'heads', head.name) : null
  if (nextRefPath === watchedBranchRefPath) return
  if (watchedBranchRefPath !== null) unwatchPath(watchedBranchRefPath)
  watchedBranchRefPath = nextRefPath
  if (nextRefPath !== null) {
    watchPath(nextRefPath, () => invalidateAllEntries())
  }
}

async function onHeadChange(): Promise<void> {
  // Invalidate BEFORE anything else; then wait out any scroll so poller
  // callbacks do not contend with the render; only then touch the
  // filesystem to re-attach.
  invalidateAllEntries()
  await waitForScrollIdle()
  await reattachBranchWatch()
}

/**
 * THE REGROUND DOOR (TASK-017 S2, git-facts-pinned-to-first-resolved-gitdir):
 * the watcher armed ONCE per process — watchedGitDir pinned to the first
 * resolved git dir, `generation` declared but never advanced — so a harness-
 * ground move (the concourse rail's REPO picker, the Boot face's Projects
 * pick) left branch/head/remote answering from repo A while isClean/
 * unpushed spawned git in repo B's cwd: one Deck row painted repo A's
 * branch beside repo B's dirty state, and writer.ts stamped repo A's
 * gitBranch into every later session record. The ground-move owner
 * (harnessGround.applyHarnessGround) calls this after its chdir: the
 * pollers are torn down, every pinned dir and cache entry is reset, the
 * generation advances so an in-flight arm discards itself, and the gitDir
 * memo is cleared — the next cached read re-resolves from the NEW cwd and
 * re-arms lazily, exactly as the first read did. Cheap when nothing was
 * armed.
 */
export function regroundGitWatch(): void {
  generation++
  teardownWatches()
  watcherStarted = false
  watcherStarting = null
  watchedGitDir = null
  watchedCommonDir = null
  watchedBranchRefPath = null
  cacheEntries.clear()
  clearResolveGitDirCache()
}

function teardownWatches(): void {
  for (const [path, listener] of watchedPaths) {
    unwatchFile(path, listener as never)
  }
  watchedPaths.clear()
}

/** Lazy start: nothing is watched until the first cached read. The shutdown cleanup registers exactly once. */
async function ensureWatcherStarted(): Promise<void> {
  if (watcherStarted) return
  if (watcherStarting !== null) return watcherStarting
  watcherStarting = (async () => {
    const startGeneration = generation
    const gitDir = await resolveGitDir()
    if (generation !== startGeneration) return
    watcherStarted = true
    if (!cleanupRegistered) {
      cleanupRegistered = true
      registerCleanup(async () => teardownWatches())
    }
    if (gitDir === null) return
    watchedGitDir = gitDir
    // Resolved once so the commondir file is not re-read per branch switch.
    watchedCommonDir = await getCommonDir(gitDir)
    if (generation !== startGeneration) return
    watchPath(join(gitDir, 'HEAD'), () => void onHeadChange())
    watchPath(join(watchedCommonDir ?? gitDir, 'config'), () => invalidateAllEntries())
    await reattachBranchWatch()
  })().finally(() => {
    watcherStarting = null
  })
  return watcherStarting
}

/**
 * The cache read: the dirty flag clears BEFORE the compute starts, so a
 * change landing mid-compute re-marks the entry and the FOLLOWING read
 * recomputes; a generation move discards the result and loops; the value
 * stores only when no fresh invalidation arrived, and is returned to the
 * caller either way.
 */
async function cachedRead<T>(key: string, compute: () => Promise<T>): Promise<T> {
  await ensureWatcherStarted()
  for (;;) {
    const startGeneration = generation
    let entry = cacheEntries.get(key)
    if (entry && !entry.dirty) {
      // A clean entry whose FIRST compute is still in flight holds only the
      // `undefined` placeholder — handing that to a racing reader painted
      // "no git" for real repos (every boot-time consumer of head/branch
      // races the first entrant). Share the in-flight compute instead.
      if (entry.inflight !== null) return (await entry.inflight) as T
      return entry.value as T
    }
    if (!entry) {
      entry = { value: undefined, dirty: true, inflight: null }
      cacheEntries.set(key, entry)
    }
    entry.dirty = false
    const inflight = compute()
    entry.inflight = inflight
    let value: T
    try {
      value = await inflight
    } finally {
      if (entry.inflight === inflight) entry.inflight = null
    }
    if (generation !== startGeneration) continue
    const current = cacheEntries.get(key)
    if (current && !current.dirty) {
      current.value = value
    }
    return value
  }
}

/** The branch name, or the literal `HEAD` when there is no git dir, no readable HEAD, or HEAD is detached. */
export async function getCachedBranch(): Promise<string> {
  return cachedRead('branch', async () => {
    if (watchedGitDir === null) return 'HEAD'
    const head = await readGitHead(watchedGitDir)
    if (head === null || head.type !== 'branch') return 'HEAD'
    return head.name
  })
}

/** The current branch's resolved sha (or the detached sha); the empty string on any miss. */
export async function getCachedHead(): Promise<string> {
  return cachedRead('head', async () => {
    if (watchedGitDir === null) return ''
    const head = await readGitHead(watchedGitDir)
    if (head === null) return ''
    if (head.type === 'detached') return head.sha
    return (await resolveRef(watchedGitDir, `refs/heads/${head.name}`)) ?? ''
  })
}

export async function getCachedRemoteUrl(): Promise<string | null> {
  return cachedRead('remoteUrl', async () => {
    if (watchedGitDir === null) return null
    const fromGitDir = await parseGitConfigValue(watchedGitDir, 'remote', 'origin', 'url')
    if (fromGitDir !== null) return fromGitDir
    if (watchedCommonDir !== null && watchedCommonDir !== watchedGitDir) {
      return parseGitConfigValue(watchedCommonDir, 'remote', 'origin', 'url')
    }
    return null
  })
}

/** origin/HEAD symref in the common dir, else origin/main then origin/master against that dir, else the literal `main`. */
export async function getCachedDefaultBranch(): Promise<string> {
  return cachedRead('defaultBranch', async () => {
    if (watchedGitDir === null) return 'main'
    const refsDir = watchedCommonDir ?? watchedGitDir
    const symref = await readRawSymref(refsDir, 'refs/remotes/origin/HEAD', 'refs/remotes/origin/')
    if (symref !== null) return symref
    for (const candidate of ['main', 'master']) {
      const sha = await resolveRefInDir(refsDir, `refs/remotes/origin/${candidate}`)
      if (sha !== null) return candidate
    }
    return 'main'
  })
}

// ————— directory-scoped readers —————

/** HEAD sha for an arbitrary directory, via the upward walk; null at any failure. */
export async function getHeadForDir(cwd: string): Promise<string | null> {
  try {
    const gitDir = await resolveGitDir(cwd)
    if (gitDir === null) return null
    const head = await readGitHead(gitDir)
    if (head === null) return null
    if (head.type === 'detached') return head.sha
    return resolveRef(gitDir, `refs/heads/${head.name}`)
  } catch {
    return null
  }
}

/**
 * HEAD sha for a worktree path, via a DIRECT `.git` pointer read with no
 * upward walk. The distinction is load-bearing: for a deleted worktree
 * path the walking reader would answer with the ENCLOSING repository's
 * HEAD, and the caller would take it for the worktree's. Null here means
 * "not a usable worktree" — exactly what the create-or-resume fast path
 * needs.
 */
export async function readWorktreeHeadSha(worktreePath: string): Promise<string | null> {
  try {
    const content = (await readFile(join(worktreePath, '.git'), 'utf8')).trim()
    if (!content.startsWith('gitdir:')) return null
    const gitDir = resolve(worktreePath, content.slice('gitdir:'.length).trim())
    const head = await readGitHead(gitDir)
    if (head === null) return null
    if (head.type === 'detached') return head.sha
    return resolveRef(gitDir, `refs/heads/${head.name}`)
  } catch {
    return null
  }
}

export async function getRemoteUrlForDir(cwd: string): Promise<string | null> {
  try {
    const gitDir = await resolveGitDir(cwd)
    if (gitDir === null) return null
    const fromGitDir = await parseGitConfigValue(gitDir, 'remote', 'origin', 'url')
    if (fromGitDir !== null) return fromGitDir
    const commonDir = await getCommonDir(gitDir)
    if (commonDir !== null && commonDir !== gitDir) {
      return parseGitConfigValue(commonDir, 'remote', 'origin', 'url')
    }
    return null
  } catch {
    return null
  }
}

/** True when a `shallow` file exists in the common dir (or git dir); false with no git dir. */
export async function isShallowClone(): Promise<boolean> {
  const gitDir = await resolveGitDir()
  if (gitDir === null) return false
  const commonDir = await getCommonDir(gitDir)
  try {
    await stat(join(commonDir ?? gitDir, 'shallow'))
    return true
  } catch {
    return false
  }
}

/**
 * Linked-worktree admin entries plus one for the primary checkout (git
 * keeps entries for LINKED worktrees only). 1 when the directory does not
 * exist; 0 with no git dir.
 */
export async function getWorktreeCountFromFs(): Promise<number> {
  const gitDir = await resolveGitDir()
  if (gitDir === null) return 0
  const commonDir = (await getCommonDir(gitDir)) ?? gitDir
  try {
    const entries = await readdir(join(commonDir, 'worktrees'))
    return entries.length + 1
  } catch {
    return 1
  }
}
