import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import chalk from 'chalk'

import { getSessionId } from '../bootstrap/state.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { findCanonicalGitRoot, findGitRoot, getDefaultBranch, gitExe } from './git.js'
import { subprocessEnv } from './subprocessEnv.js'
import { readWorktreeHeadSha, resolveGitDir, resolveRef, getCommonDir } from './git/gitFilesystem.js'
import { parseGitConfigValue } from './git/gitConfigParser.js'
import { saveCurrentProjectConfig } from './config.js'
import { containsPathTraversal } from './path.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { executeWorktreeCreateHook, executeWorktreeRemoveHook, hasWorktreeCreateHook } from './hooks.js'
import { logError } from './log.js'
import { nonAdoptiveProjectPath } from './projectStoreAdoption.js'
import { getInitialSettings, getRelativeSettingsFilePathForSource } from './settings/settings.js'
import { sleep } from './sleep.js'
import { isInITerm2, isInsideTmuxSync } from './swarm/backends/detection.js'

/**
 * Git-worktree lifecycle for sessions, agents and workflows: creation and
 * resume, the typed workspace delta, settlement receipts, the capability
 * preflight, the stale-lane janitor, the detached baseline worktree, and
 * the `--worktree --tmux` fast path.
 */

// ————— slug validation —————

const MAX_SLUG_LENGTH = 64

/**
 * Throws on an unacceptable slug, and must run BEFORE any side effect
 * (hooks, git commands, directory creation) — callers rely on that. The
 * strictness is load-bearing: the slug is joined into a path under the
 * worktrees home, and `..` segments or an absolute path would escape or
 * discard the prefix. A leading or trailing slash produces an empty
 * segment, which the allowlist rejects, so neither needs its own rule.
 */
export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(`Worktree name exceeds the ${MAX_SLUG_LENGTH}-character limit (${slug.length})`)
  }
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(`Worktree name "${slug}" contains a "." or ".." segment`)
    }
    if (segment === '' || !/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error(
        `Worktree name "${slug}" is invalid: each slash-separated segment must be non-empty and may contain only letters, digits, dots, underscores and dashes`,
      )
    }
  }
}

// ————— naming and layout —————

/**
 * The worktrees home under the NON-ADOPTIVE project-path resolver:
 * worktrees are disposable machinery, and the one-time legacy-store
 * adoption once duplicated very large checkouts whose git administrative
 * data still referenced the paths they were copied from.
 */
function worktreesHome(gitRoot: string): string {
  return nonAdoptiveProjectPath(gitRoot, 'worktrees')
}

/**
 * Nested slugs are flattened (`/` → `+`) for both the branch and the
 * directory: nesting breaks a ref namespace where a same-prefix file
 * already exists, and a nested lane physically inside its parent is
 * deleted with it. `+` is accepted by git and filesystems and rejected by
 * the slug validator, making the flattening collision-free.
 */
function flattenSlug(slug: string): string {
  return slug.replace(/\//g, '+')
}

/** Contract data: the prefix is matched by the janitor. */
export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`
}

function worktreePathForSlug(gitRoot: string, slug: string): string {
  return join(worktreesHome(gitRoot), flattenSlug(slug))
}

// ————— base-commit baseline —————

// Source-pinned declaration.
const BASELINE_FILENAME = 'WORKTREE_BASE'

/** Resolves a linked worktree's `.git` pointer to its per-worktree admin directory; null when malformed or missing. */
async function resolveWorktreeAdminDir(worktreePath: string): Promise<string | null> {
  try {
    const content = (await readFile(join(worktreePath, '.git'), 'utf8')).trim()
    if (!content.startsWith('gitdir:')) return null
    return resolve(worktreePath, content.slice('gitdir:'.length).trim())
  } catch {
    return null
  }
}

/** Best-effort: neither an unresolvable admin dir nor a failed write blocks creation. */
async function writeWorktreeBaseline(worktreePath: string, sha: string): Promise<void> {
  const adminDir = await resolveWorktreeAdminDir(worktreePath)
  if (adminDir === null) {
    logForDebugging(`worktree baseline not written: no admin dir for ${worktreePath}`)
    return
  }
  try {
    await writeFile(join(adminDir, BASELINE_FILENAME), sha)
  } catch (error) {
    logForDebugging(`worktree baseline write failed: ${String(error)}`)
  }
}

/** Abbreviated-or-full sha (7-64 hex, case-insensitive); null when missing, unreadable or malformed. */
async function readWorktreeBaseline(worktreePath: string): Promise<string | null> {
  const adminDir = await resolveWorktreeAdminDir(worktreePath)
  if (adminDir === null) return null
  let content: string
  try {
    content = await readFile(join(adminDir, BASELINE_FILENAME), 'utf8')
  } catch {
    return null
  }
  const trimmed = content.trim()
  return /^[0-9a-fA-F]{7,64}$/.test(trimmed) ? trimmed : null
}

// ————— git execution helpers —————

/** Credential-prompt suppression: without it a fetch prompt hangs the CLI. Contract data — git's own variables. */
function noPromptEnv(): NodeJS.ProcessEnv {
  return { ...subprocessEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' }
}

async function runGit(
  args: string[],
  cwd: string,
  options?: { suppressPrompts?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await execFileNoThrowWithCwd(gitExe(), args, {
    cwd,
    ...(options?.suppressPrompts ? { env: noPromptEnv(), stdin: 'ignore' as never } : {}),
  })
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

// ————— create-or-resume —————

type CreateOrResumeResult = {
  worktreePath: string
  worktreeBranch: string
  headCommit: string | null
  existed: boolean
  baseBranch?: string
}

async function createOrResumeWorktree(
  repoRoot: string,
  slug: string,
  options?: { prNumber?: number },
): Promise<CreateOrResumeResult> {
  const worktreePath = worktreePathForSlug(repoRoot, slug)
  const branchName = worktreeBranchName(slug)

  // Fast resume: HEAD straight off the .git pointer — no subprocess and no
  // upward walk (both measured). The baseline is preferred over current
  // HEAD so commits-ahead computations see the original base.
  const existingHead = await readWorktreeHeadSha(worktreePath)
  if (existingHead !== null) {
    const baseline = await readWorktreeBaseline(worktreePath)
    return {
      worktreePath,
      worktreeBranch: branchName,
      headCommit: baseline ?? existingHead,
      existed: true,
    }
  }

  await mkdir(worktreesHome(repoRoot), { recursive: true })

  let baseRef: string
  let baseSha: string | null = null
  let baseBranch: string | undefined
  if (options?.prNumber !== undefined) {
    const fetch = await runGit(['fetch', 'origin', `pull/${options.prNumber}/head`], repoRoot, {
      suppressPrompts: true,
    })
    if (fetch.code !== 0) {
      const detail =
        fetch.stderr.trim() !== ''
          ? fetch.stderr.trim()
          : 'the PR may not exist, or this repository may have no origin remote'
      throw new Error(`Could not fetch PR #${options.prNumber}: ${detail}`)
    }
    baseRef = 'FETCH_HEAD'
  } else {
    const [defaultBranch, gitDir] = await Promise.all([getDefaultBranch(repoRoot), resolveGitDir(repoRoot)])
    baseBranch = `origin/${defaultBranch}`
    const localRemoteSha = gitDir !== null ? await resolveRef(gitDir, `refs/remotes/origin/${defaultBranch}`) : null
    if (localRemoteSha !== null) {
      // Large-repo optimisation: the remote ref is already local, so skip
      // the fetch (seconds of commit-graph scan) and reuse the sha; a
      // slightly stale base is acceptable.
      baseRef = `origin/${defaultBranch}`
      baseSha = localRemoteSha
    } else {
      const fetch = await runGit(['fetch', 'origin', defaultBranch], repoRoot, { suppressPrompts: true })
      baseRef = fetch.code === 0 ? `origin/${defaultBranch}` : 'HEAD'
      if (fetch.code !== 0) baseBranch = 'HEAD'
    }
  }

  if (baseSha === null) {
    const revParse = await runGit(['rev-parse', baseRef], repoRoot)
    if (revParse.code !== 0) {
      throw new Error(`Could not resolve the worktree base ref ${baseRef}`)
    }
    baseSha = revParse.stdout.trim()
  }

  const sparsePaths = getInitialSettings().worktree?.sparsePaths ?? []
  const useSparse = sparsePaths.length > 0

  // -B, not -b: a worktree removed without its branch leaves the branch
  // behind, and force-create resets it in place.
  const addArgs = ['worktree', 'add', '-B', branchName]
  if (useSparse) addArgs.push('--no-checkout')
  addArgs.push(worktreePath, baseRef)
  const add = await runGit(addArgs, repoRoot)
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr.trim()}`)
  }

  if (useSparse) {
    try {
      const sparse = await runGit(['sparse-checkout', 'set', '--cone', '--', ...sparsePaths], worktreePath)
      if (sparse.code !== 0) throw new Error(`git sparse-checkout failed: ${sparse.stderr.trim()}`)
      const checkout = await runGit(['checkout', 'HEAD'], worktreePath)
      if (checkout.code !== 0) throw new Error(`git checkout failed in the sparse worktree: ${checkout.stderr.trim()}`)
    } catch (error) {
      // The teardown is the trap avoided: without it the half-built lane
      // stays registered with a valid HEAD and an EMPTY tree, and the next
      // fast-resume hands the caller a lane with nothing in it.
      await runGit(['worktree', 'remove', '--force', worktreePath], repoRoot)
      throw error
    }
  }

  await writeWorktreeBaseline(worktreePath, baseSha)
  return {
    worktreePath,
    worktreeBranch: branchName,
    headCommit: baseSha,
    existed: false,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
  }
}

// ————— post-creation setup —————

/** Copies gitignored-but-wanted files (`.worktreeinclude`, gitignore syntax) into a new worktree; returns the copied relative paths. */
export async function copyWorktreeIncludeFiles(repoRoot: string, worktreePath: string): Promise<string[]> {
  let patternText: string
  try {
    patternText = await readFile(join(repoRoot, '.worktreeinclude'), 'utf8')
  } catch {
    return []
  }
  const patterns = patternText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  if (patterns.length === 0) return []

  // One pass over the repository's ignored entries. `--directory` is what
  // makes it cheap: a wholly-ignored directory comes back as ONE entry.
  const listing = await runGit(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    repoRoot,
  )
  if (listing.code !== 0 || listing.stdout.trim() === '') return []
  const entries = listing.stdout.split('\n').filter(entry => entry !== '')

  const { default: ignore } = await import('ignore')
  const matcher = ignore().add(patternText)

  const selected: string[] = []
  const collapsedDirs: string[] = []
  for (const entry of entries) {
    if (entry.endsWith('/')) collapsedDirs.push(entry)
    else if (matcher.ignores(entry)) selected.push(entry)
  }

  // A pattern may target a path INSIDE a collapsed (wholly-ignored)
  // directory. Expansion is deliberately scoped: anchorless patterns and
  // recursive-wildcard patterns expand nothing — honouring them would mean
  // walking every collapsed directory, which is the full tree walk the
  // single listing exists to avoid.
  const dirsToExpand = collapsedDirs.filter(dir => {
    const bare = dir.slice(0, -1)
    return patterns.some(pattern => {
      const anchored = pattern.startsWith('/') ? pattern.slice(1) : pattern
      if (anchored.startsWith(dir)) return true
      const globIndex = anchored.search(/[*?[]/)
      if (globIndex > 0) {
        const literalPrefix = anchored.slice(0, globIndex)
        if (bare.startsWith(literalPrefix) || literalPrefix.startsWith(`${bare}/`)) return true
      }
      return false
    }) || matcher.ignores(bare)
  })
  if (dirsToExpand.length > 0) {
    const scoped = await runGit(
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...dirsToExpand],
      repoRoot,
    )
    if (scoped.code === 0) {
      for (const entry of scoped.stdout.split('\n')) {
        if (entry !== '' && matcher.ignores(entry)) selected.push(entry)
      }
    }
  }

  const copied: string[] = []
  for (const relativePath of selected) {
    try {
      const target = join(worktreePath, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(repoRoot, relativePath), target)
      copied.push(relativePath)
    } catch (error) {
      logForDebugging(`worktreeinclude copy failed for ${relativePath}: ${String(error)}`, {
        level: 'warn' as never,
      })
    }
  }
  if (copied.length > 0) {
    logForDebugging(`worktreeinclude copied ${copied.length} files: ${copied.join(', ')}`)
  }
  return copied
}

/** Runs only for freshly created worktrees; every step is best-effort. */
async function runPostCreationSetup(repoRoot: string, worktreePath: string): Promise<void> {
  // 1. Local settings propagation — the file that can hold operator
  //    secrets; copying it into the lane is intentional.
  try {
    const relativeSettingsPath = getRelativeSettingsFilePathForSource('localSettings')
    const target = join(worktreePath, relativeSettingsPath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(repoRoot, relativeSettingsPath), target)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      logForDebugging(`local settings propagation failed: ${String(error)}`, { level: 'warn' as never })
    }
  }

  // 2. Hooks path: config write lands in the SHARED repo config, so after
  //    the first worktree every later create can skip the spawn.
  try {
    let hooksPath: string | null = null
    for (const candidate of [join(repoRoot, '.husky'), join(repoRoot, '.git', 'hooks')]) {
      try {
        if ((await stat(candidate)).isDirectory()) {
          hooksPath = candidate
          break
        }
      } catch {
        // Try the next candidate.
      }
    }
    if (hooksPath !== null) {
      const gitDir = await resolveGitDir(repoRoot)
      const configDir = gitDir !== null ? ((await getCommonDir(gitDir)) ?? gitDir) : null
      const configured = configDir !== null ? await parseGitConfigValue(configDir, 'core', null, 'hookspath') : null
      if (configured !== hooksPath) {
        const result = await runGit(['config', 'core.hooksPath', hooksPath], worktreePath)
        logForDebugging(
          result.code === 0 ? `worktree hooksPath set to ${hooksPath}` : `worktree hooksPath set failed: ${result.stderr.trim()}`,
        )
      }
    }
  } catch (error) {
    logForDebugging(`worktree hooks-path setup failed: ${String(error)}`)
  }

  // 3. Symlinked directories, to avoid duplicating large trees.
  const symlinkDirectories = getInitialSettings().worktree?.symlinkDirectories ?? []
  for (const directoryName of symlinkDirectories) {
    if (containsPathTraversal(directoryName)) {
      logForDebugging(`worktree symlink entry skipped (path traversal): ${directoryName}`, {
        level: 'warn' as never,
      })
      continue
    }
    try {
      await symlink(join(repoRoot, directoryName), join(worktreePath, directoryName), 'dir')
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT' && code !== 'EEXIST') {
        logForDebugging(`worktree symlink failed for ${directoryName}: ${code ?? String(error)}`, {
          level: 'warn' as never,
        })
      }
    }
  }

  // 4. `.worktreeinclude` copy.
  await copyWorktreeIncludeFiles(repoRoot, worktreePath)
}

// ————— session worktrees —————

export type WorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
  /** Unset when resuming. */
  creationDurationMs?: number
  usedSparsePaths?: boolean
}

let currentWorktreeSession: WorktreeSession | null = null

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession
}

/** Sets the slot on resume; the caller has already verified the directory and set bootstrap state. */
export function restoreWorktreeSession(session: WorktreeSession | null): void {
  currentWorktreeSession = session
}

function persistWorktreeSession(session: WorktreeSession | null): void {
  saveCurrentProjectConfig(config => {
    if (session === null) {
      const { activeWorktreeSession: _dropped, ...rest } = config
      return rest
    }
    return {
      ...config,
      activeWorktreeSession: {
        originalCwd: session.originalCwd,
        worktreePath: session.worktreePath,
        worktreeName: session.worktreeName,
        ...(session.originalBranch !== undefined ? { originalBranch: session.originalBranch } : {}),
        sessionId: session.sessionId,
        ...(session.hookBased !== undefined ? { hookBased: session.hookBased } : {}),
      },
    }
  })
}

export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  tmuxSessionName?: string,
  options?: { prNumber?: number },
): Promise<WorktreeSession> {
  // Validation FIRST — before hooks, git or directory creation.
  validateWorktreeSlug(slug)
  const originalCwd = getCwd()

  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    const session: WorktreeSession = {
      originalCwd,
      worktreePath: hookResult.worktreePath,
      worktreeName: slug,
      sessionId,
      ...(tmuxSessionName !== undefined ? { tmuxSessionName } : {}),
      hookBased: true,
    }
    currentWorktreeSession = session
    persistWorktreeSession(session)
    return session
  }

  const gitRoot = findGitRoot(originalCwd)
  if (!gitRoot) {
    throw new Error(
      'Cannot create a worktree: this is not a git repository and no WorktreeCreate hooks are configured. ' +
        'Configure WorktreeCreate/WorktreeRemove hooks in settings to use worktree isolation with other VCS systems.',
    )
  }

  let originalBranch: string | undefined
  const gitDir = await resolveGitDir(gitRoot)
  if (gitDir !== null) {
    const { readGitHead } = await import('./git/gitFilesystem.js')
    const head = await readGitHead(gitDir)
    if (head?.type === 'branch') originalBranch = head.name
  }

  const startedAt = Date.now()
  const created = await createOrResumeWorktree(gitRoot, slug, options)
  logForDebugging(
    created.existed
      ? `resumed worktree ${created.worktreePath}`
      : `created worktree ${created.worktreePath} from ${created.baseBranch ?? 'HEAD'}`,
  )
  if (!created.existed) {
    await runPostCreationSetup(gitRoot, created.worktreePath)
  }

  const usedSparse = (getInitialSettings().worktree?.sparsePaths ?? []).length > 0
  const session: WorktreeSession = {
    originalCwd,
    worktreePath: created.worktreePath,
    worktreeName: slug,
    worktreeBranch: created.worktreeBranch,
    ...(originalBranch !== undefined ? { originalBranch } : {}),
    ...(created.headCommit !== null ? { originalHeadCommit: created.headCommit } : {}),
    sessionId,
    ...(tmuxSessionName !== undefined ? { tmuxSessionName } : {}),
    // Only the fresh path is timed.
    ...(created.existed ? {} : { creationDurationMs: Date.now() - startedAt }),
    ...(usedSparse && !created.existed ? { usedSparsePaths: true } : {}),
  }
  currentWorktreeSession = session
  persistWorktreeSession(session)
  return session
}

/** Preserves the worktree: chdir back, clear the slot and the persisted record, and say how to continue. Never throws. */
export async function keepWorktree(): Promise<void> {
  try {
    const session = currentWorktreeSession
    if (session === null) return
    process.chdir(session.originalCwd)
    currentWorktreeSession = null
    persistWorktreeSession(null)
    logForDebugging(
      `worktree preserved at ${session.worktreePath}${session.worktreeBranch ? ` (branch ${session.worktreeBranch})` : ''}; cd there to continue working in it`,
    )
  } catch (error) {
    logForDebugging(`keepWorktree failed: ${String(error)}`)
  }
}

/** Removes the session worktree. Every failure logs; nothing throws. */
export async function cleanupWorktree(): Promise<void> {
  const session = currentWorktreeSession
  if (session === null) return
  try {
    // Chdir back FIRST — git refuses to remove the directory we stand in.
    process.chdir(session.originalCwd)
  } catch (error) {
    logForDebugging(`cleanupWorktree chdir failed: ${String(error)}`)
  }
  try {
    if (session.hookBased) {
      const ran = await executeWorktreeRemoveHook(session.worktreePath)
      if (ran) logForDebugging(`WorktreeRemove hook removed ${session.worktreePath}`)
      else {
        logForDebugging(`no WorktreeRemove hook configured; hook-based worktree left in place: ${session.worktreePath}`, {
          level: 'warn' as never,
        })
      }
    } else {
      // The EXPLICIT cwd is load-bearing: process.chdir does not move the
      // session's own recorded cwd, which is what the execution helper
      // falls back to — and that may have been moved outside a repository
      // during the turn.
      const removal = await runGit(['worktree', 'remove', '--force', session.worktreePath], session.originalCwd)
      if (removal.code !== 0) {
        logForDebugging(`worktree remove failed: ${removal.stderr.trim()}`)
      }
    }
    currentWorktreeSession = null
    persistWorktreeSession(null)
    if (!session.hookBased && session.worktreeBranch !== undefined) {
      // Long enough for git to drop its locks.
      await sleep(100)
      const branchDelete = await runGit(['branch', '-D', session.worktreeBranch], session.originalCwd)
      if (branchDelete.code !== 0) {
        logForDebugging(`worktree branch delete failed: ${branchDelete.stderr.trim()}`)
      }
    }
  } catch (error) {
    logForDebugging(`cleanupWorktree failed: ${String(error)}`)
  }
}

// ————— agent worktrees —————

export type WorktreeCapability = {
  available: boolean
  detail: string
  prerequisite?: 'git-repository-or-worktree-create-hook'
  repeatCount?: number
}

const refusalCountsByDirectory = new Map<string, number>()

export function _resetWorktreeRefusalCountsForTesting(): void {
  refusalCountsByDirectory.clear()
}

/**
 * Evaluates, up front and as a typed value, exactly the two facts creation
 * would fail on — BEFORE any agent allocates.
 */
export function preflightWorktreeCapability(cwd: string = getCwd()): WorktreeCapability {
  if (hasWorktreeCreateHook()) {
    return { available: true, detail: 'WorktreeCreate hook is configured', repeatCount: 0 } as WorktreeCapability
  }
  const gitRoot = findCanonicalGitRoot(cwd)
  if (gitRoot) {
    return { available: true, detail: `git repository at ${gitRoot}`, repeatCount: 0 } as WorktreeCapability
  }
  const repeatCount = (refusalCountsByDirectory.get(cwd) ?? 0) + 1
  refusalCountsByDirectory.set(cwd, repeatCount)
  let detail =
    `Worktree isolation is unavailable in ${cwd}: not a git repository and no WorktreeCreate hook is configured. ` +
    'For read-only work, retry the same call WITHOUT the isolation parameter. ' +
    'For write work, start Mercury inside the repository. ' +
    'This refusal is deterministic for this directory — an identical relaunch will refuse again.'
  if (repeatCount >= 2) {
    detail += ` (repeat refusal #${repeatCount}; the parameters have not changed)`
  }
  return {
    available: false,
    detail,
    prerequisite: 'git-repository-or-worktree-create-hook',
    repeatCount,
  }
}

export async function createAgentWorktree(slug: string): Promise<{
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}> {
  validateWorktreeSlug(slug)
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    return { worktreePath: hookResult.worktreePath, hookBased: true }
  }
  // CANONICAL root, deliberately: agent lanes must live in the top-level
  // repository's worktrees home even when spawned from inside a session
  // worktree — a plainly-resolved lane would sit beneath that worktree,
  // out of reach of the janitor, which only scans the canonical root.
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    // Addressed to the CALLER — a model receiving this mid-dispatch cannot
    // edit a settings file; both fragments are source-text pins.
    throw new Error(
      'Worktree isolation is unavailable here: this is not a git repository and no WorktreeCreate hook is configured. ' +
        'Retry the same Agent call WITHOUT the isolation parameter; the agent will run in the current directory.',
    )
  }
  const created = await createOrResumeWorktree(gitRoot, slug)
  if (!created.existed) {
    await runPostCreationSetup(gitRoot, created.worktreePath)
    // The lock is what keeps two agents off one path: while locked, git
    // refuses adding and removing it from any other process. Best-effort.
    const lock = await runGit(
      ['worktree', 'lock', created.worktreePath, '--reason', `agent ${slug} (pid ${process.pid})`],
      gitRoot,
    )
    if (lock.code !== 0) {
      logForDebugging(`worktree lock failed for ${created.worktreePath}: ${lock.stderr.trim()}`)
    }
  } else {
    // Fast resume touches nothing; without the bump the directory keeps
    // its creation timestamp, which may already sit behind the janitor's
    // cutoff.
    try {
      const now = new Date()
      await utimes(created.worktreePath, now, now)
    } catch {
      // Best-effort.
    }
    logForDebugging(`resumed agent worktree ${created.worktreePath}`)
  }
  return {
    worktreePath: created.worktreePath,
    worktreeBranch: created.worktreeBranch,
    ...(created.headCommit !== null ? { headCommit: created.headCommit } : {}),
    gitRoot,
  }
}

/** Best-effort and idempotent. */
export async function unlockAgentWorktree(worktreePath: string, gitRoot: string): Promise<void> {
  await runGit(['worktree', 'unlock', worktreePath], gitRoot)
}

export async function removeAgentWorktree(
  worktreePath: string,
  worktreeBranch?: string,
  gitRoot?: string,
  hookBased?: boolean,
): Promise<boolean> {
  if (hookBased) {
    const ran = await executeWorktreeRemoveHook(worktreePath)
    if (!ran) {
      logForDebugging(`no WorktreeRemove hook configured; hook-based worktree left in place: ${worktreePath}`, {
        level: 'warn' as never,
      })
    }
    return ran
  }
  if (gitRoot === undefined) {
    logError(new Error(`removeAgentWorktree: no git root for ${worktreePath}`))
    return false
  }
  // The create-time lock releases first — git will not delete a worktree
  // it still holds locked. Removal runs from the MAIN repo root, never
  // from the directory about to be deleted.
  await unlockAgentWorktree(worktreePath, gitRoot)
  const removal = await runGit(['worktree', 'remove', '--force', worktreePath], gitRoot)
  if (removal.code !== 0) {
    logForDebugging(`agent worktree remove failed: ${removal.stderr.trim()}`)
    return false
  }
  if (worktreeBranch !== undefined) {
    const branchDelete = await runGit(['branch', '-D', worktreeBranch], gitRoot)
    if (branchDelete.code !== 0) {
      logForDebugging(`agent worktree branch delete failed: ${branchDelete.stderr.trim()}`)
    }
  }
  return true
}

// ————— the typed workspace delta —————

/**
 * The ephemeral registry names ONLY namespaces Mercury's own runtime
 * bookkeeping writes — never a directory family a project might use.
 */
const MERCURY_EPHEMERAL_PREFIXES = ['.mercury/cache-clock/']

export function isMercuryEphemeralLanePath(relPath: string): boolean {
  return MERCURY_EPHEMERAL_PREFIXES.some(prefix => relPath.startsWith(prefix))
}

export type WorktreeDelta = {
  /** Commits ahead of the creation base; 0 when the base is unknown. */
  commitsAhead: number
  /** Tracked modifications/deletions/renames — BOTH sides of a rename. */
  tracked: string[]
  untrackedAuthored: string[]
  mercuryEphemeral: string[]
  /** Non-null exactly when inspection failed; every consumer fails closed on it. */
  uncertainty: string | null
}

/** Pure classifier over NUL-separated porcelain-v1 records (exported for fixtures). */
export function classifyPorcelainRecords(zOutput: string): {
  tracked: string[]
  untrackedAuthored: string[]
  mercuryEphemeral: string[]
} {
  const tracked: string[] = []
  const untrackedAuthored: string[] = []
  const mercuryEphemeral: string[] = []
  const records = zOutput.split('\u0000')
  for (let index = 0; index < records.length; index++) {
    const record = records[index] as string
    if (record.length < 4) continue
    const statusPair = record.slice(0, 2)
    const path = record.slice(3)
    if (statusPair === '??') {
      if (isMercuryEphemeralLanePath(path)) mercuryEphemeral.push(path)
      else untrackedAuthored.push(path)
      continue
    }
    tracked.push(path)
    if (statusPair.includes('R') || statusPair.includes('C')) {
      // The next NUL record is the rename/copy origin path.
      const origin = records[index + 1]
      if (origin !== undefined && origin !== '') {
        tracked.push(origin)
        index++
      }
    }
  }
  return { tracked, untrackedAuthored, mercuryEphemeral }
}

/**
 * `-uall` (never `-uno`): the old janitor reading ignored ALL untracked
 * files, authored ones included. A rev-list failure still returns the
 * classified path lists — only `uncertainty` marks the failure.
 */
export async function readWorktreeDelta(worktreePath: string, headCommit?: string): Promise<WorktreeDelta> {
  const status = await runGit(['--no-optional-locks', 'status', '--porcelain=v1', '-uall', '-z'], worktreePath)
  if (status.code !== 0) {
    return {
      commitsAhead: 0,
      tracked: [],
      untrackedAuthored: [],
      mercuryEphemeral: [],
      uncertainty: `git status exited ${status.code}`,
    }
  }
  const classified = classifyPorcelainRecords(status.stdout)
  let commitsAhead = 0
  let uncertainty: string | null = null
  if (headCommit !== undefined) {
    const revList = await runGit(['rev-list', '--count', `${headCommit}..HEAD`], worktreePath)
    if (revList.code !== 0) {
      uncertainty = `git rev-list exited ${revList.code}`
    } else {
      const parsed = parseInt(revList.stdout.trim(), 10)
      if (Number.isNaN(parsed)) uncertainty = 'git rev-list output was malformed'
      else commitsAhead = parsed
    }
  }
  return { commitsAhead, ...classified, uncertainty }
}

/** Authored work always wins; Mercury-ephemeral debris never blocks. */
export function deltaBlocksSettlement(delta: WorktreeDelta): boolean {
  return (
    delta.uncertainty !== null ||
    delta.commitsAhead > 0 ||
    delta.tracked.length > 0 ||
    delta.untrackedAuthored.length > 0
  )
}

export function describeWorktreeDelta(delta: WorktreeDelta): string {
  if (delta.uncertainty !== null) {
    return `inspection unavailable: ${delta.uncertainty}`
  }
  const parts: string[] = []
  if (delta.commitsAhead > 0) {
    parts.push(`${delta.commitsAhead} commit${delta.commitsAhead === 1 ? '' : 's'}`)
  }
  const pathsPart = (paths: string[], label: string): string => {
    const shown = paths.slice(0, 3).join(', ')
    const ellipsis = paths.length > 3 ? ', …' : ''
    return `${paths.length} ${label}${paths.length === 1 ? '' : 's'} (${shown}${ellipsis})`
  }
  if (delta.tracked.length > 0) parts.push(pathsPart(delta.tracked, 'tracked change'))
  if (delta.untrackedAuthored.length > 0) parts.push(pathsPart(delta.untrackedAuthored, 'authored file'))
  if (parts.length === 0) return 'no authored work'
  return parts.join(' · ')
}

/** The legacy boolean projection: exactly "does the delta block settlement?". */
export async function hasWorktreeChanges(worktreePath: string, headCommit: string): Promise<boolean> {
  const delta = await readWorktreeDelta(worktreePath, headCommit)
  return deltaBlocksSettlement(delta)
}

// ————— settlement receipts —————

export type WorktreeSettlementReceipt =
  | { outcome: 'settled'; worktreePath: string }
  | { outcome: 'preserved'; worktreePath: string; delta: WorktreeDelta; summary: string }
  | { outcome: 'kept-hook-based'; worktreePath: string }
  | { outcome: 'inspection-unavailable'; worktreePath: string; detail: string }
  | { outcome: 'retryable-partial'; worktreePath: string; detail: string }

/** The caller must quiesce the lane's writer before settling. */
export async function settleAgentWorktree(info: {
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}): Promise<WorktreeSettlementReceipt> {
  if (info.hookBased) {
    return { outcome: 'kept-hook-based', worktreePath: info.worktreePath }
  }
  const delta = await readWorktreeDelta(info.worktreePath, info.headCommit)
  if (delta.uncertainty !== null) {
    return { outcome: 'inspection-unavailable', worktreePath: info.worktreePath, detail: delta.uncertainty }
  }
  if (deltaBlocksSettlement(delta)) {
    return {
      outcome: 'preserved',
      worktreePath: info.worktreePath,
      delta,
      summary: describeWorktreeDelta(delta),
    }
  }
  const removed = await removeAgentWorktree(info.worktreePath, info.worktreeBranch, info.gitRoot, false)
  if (!removed) {
    return {
      outcome: 'retryable-partial',
      worktreePath: info.worktreePath,
      detail: 'removal failed; see the debug log',
    }
  }
  // Verify absence: only a genuine absence yields `settled`.
  try {
    await stat(info.worktreePath)
    return {
      outcome: 'retryable-partial',
      worktreePath: info.worktreePath,
      detail: 'the path is still present after removal',
    }
  } catch {
    return { outcome: 'settled', worktreePath: info.worktreePath }
  }
}

// ————— the stale-lane janitor —————

// Exact ephemeral shapes, so user-named worktrees are never swept.
const EPHEMERAL_SLUG_PATTERNS: RegExp[] = [
  /^agent-a[0-9a-f]{7,32}$/, // agent lanes (historical 8-hex and current 16-hex prefixes)
  /^parcel-[0-9a-f]{6,32}$/,
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/,
  /^wf-\d+$/, // legacy workflow lanes from older builds
  /^bridge-[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/, // hyphen-separated groups; underscores inside a group
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,
]

function isEphemeralSlug(slug: string): boolean {
  return EPHEMERAL_SLUG_PATTERNS.some(pattern => pattern.test(slug))
}

const EPHEMERAL_RETENTION_FLOOR_MS = 7 * 24 * 60 * 60 * 1000

/**
 * "Does git still own this directory?" — a round trip: the directory's
 * `.git` pointer names an admin dir whose `gitdir` file must name this
 * directory's own `.git` again. Both ends resolve through the
 * filesystem's canonical form (macOS temp aliasing would otherwise make a
 * live lane compare unequal to itself and be reaped); a resolution that
 * throws is disowned.
 */
async function isDisownedWorktree(worktreePath: string): Promise<boolean> {
  const adminDir = await resolveWorktreeAdminDir(worktreePath)
  if (adminDir === null) return true
  try {
    const returnLeg = (await readFile(join(adminDir, 'gitdir'), 'utf8')).trim()
    const canonicalReturn = await realpath(returnLeg)
    const canonicalOwn = await realpath(join(worktreePath, '.git'))
    return canonicalReturn !== canonicalOwn
  } catch {
    return true
  }
}

/** Removes leaked ephemeral worktrees older than the cutoff (floored at seven days). Returns the number removed. */
export async function cleanupStaleAgentWorktrees(cutoffDate: Date): Promise<number> {
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) return 0

  // The caller can never make the sweep MORE permissive than the floor.
  const cutoffMs = Math.max(cutoffDate.getTime(), Date.now() - EPHEMERAL_RETENTION_FLOOR_MS)
  const home = worktreesHome(gitRoot)
  let removedCount = 0

  // Two sweep sources, both required: the registry reaches lanes living
  // outside the canonical home; the directory listing reaches directories
  // the registry has no entry for at all.
  const candidates = new Map<string, string>()
  let registryReadable = false
  const registeredPaths = new Set<string>()
  const registry = await runGit(['worktree', 'list', '--porcelain'], gitRoot)
  if (registry.code === 0) {
    registryReadable = true
    for (const line of registry.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue
      const path = line.slice('worktree '.length)
      registeredPaths.add(path)
      if (path === gitRoot) continue
      if (basename(dirname(path)) !== 'worktrees') continue
      candidates.set(path, basename(path))
    }
  }
  try {
    for (const entry of await readdir(home)) {
      candidates.set(join(home, entry), entry)
    }
  } catch {
    // A missing home is not an error; continue with the registry's finds.
  }

  for (const [candidatePath, slug] of candidates) {
    if (!isEphemeralSlug(slug)) continue
    if (currentWorktreeSession !== null && candidatePath === currentWorktreeSession.worktreePath) continue
    let mtimeMs: number
    try {
      mtimeMs = (await stat(candidatePath)).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs >= cutoffMs) continue

    // Orphan reap: unregistered and disowned — remove the tree outright.
    if (registryReadable && !registeredPaths.has(candidatePath) && (await isDisownedWorktree(candidatePath))) {
      try {
        await rm(candidatePath, { recursive: true, force: true })
        removedCount++
      } catch {
        // Busy or permission-blocked — the next sweep retries.
      }
      continue
    }

    // Both probes fail closed. The janitor reads the delta WITHOUT a head
    // commit, so the remote-reachability probe is the whole of its commit
    // safety.
    const [delta, unpushed] = await Promise.all([
      readWorktreeDelta(candidatePath),
      runGit(['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'], candidatePath),
    ])
    if (deltaBlocksSettlement(delta)) continue
    if (unpushed.code !== 0 || unpushed.stdout.trim() !== '') continue

    const removed = await removeAgentWorktree(candidatePath, worktreeBranchName(slug), gitRoot, false)
    if (removed) removedCount++
  }

  // Crashed-adoption debris beside the canonical home.
  try {
    const parent = dirname(home)
    const homeName = basename(home)
    for (const entry of await readdir(parent)) {
      if (!entry.startsWith(`${homeName}.adopting-`)) continue
      const debrisPath = join(parent, entry)
      try {
        if ((await stat(debrisPath)).mtimeMs < cutoffMs) {
          await rm(debrisPath, { recursive: true, force: true })
          removedCount++
        }
      } catch {
        // Skip unstattable/busy debris.
      }
    }
  } catch {
    // A missing parent is not an error.
  }

  if (removedCount > 0) {
    await runGit(['worktree', 'prune'], gitRoot)
    logForDebugging(`worktree janitor removed ${removedCount} stale lanes`)
  }
  return removedCount
}

// ————— detached baseline worktree —————

/**
 * A stash-free A/B comparison journey: a read-only checkout at a requested
 * revision, never mutating the live tree. Every git invocation here uses
 * the bare command name `git` (preserved deliberately).
 */
export async function createBaselineWorktree(
  revision: string,
  root?: string,
): Promise<
  | { ok: true; path: string; revision: string; leaseId: string; dispose: () => Promise<void> }
  | { ok: false; reason: string }
> {
  const repoRoot = root ?? getCwd()
  const verify = await execFileNoThrowWithCwd('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
    cwd: repoRoot,
  })
  const sha = verify.stdout.trim()
  if (verify.code !== 0 || sha === '') {
    return { ok: false, reason: `"${revision}" is not a commit in this repository` }
  }

  // Lazily imported to keep these modules off the startup chain.
  const { getProjectTempDir } = await import('./permissions/filesystem.js')
  const { registerScratchLease, releaseScratchLease } = await import('./scratchLeases.js')

  const targetPath = join(getProjectTempDir(), 'baselines', sha.slice(0, 12))

  let alreadyThere = false
  const probe = await execFileNoThrowWithCwd('git', ['-C', targetPath, 'rev-parse', 'HEAD'], { cwd: repoRoot })
  if (probe.code === 0 && probe.stdout.trim() === sha) alreadyThere = true

  if (!alreadyThere) {
    const add = await execFileNoThrowWithCwd('git', ['worktree', 'add', '--detach', '--force', targetPath, sha], {
      cwd: repoRoot,
    })
    if (add.code !== 0) {
      const firstLine = (add.stderr.trim() !== '' ? add.stderr : add.stdout).trim().split('\n')[0] ?? ''
      return { ok: false, reason: firstLine }
    }
  }

  const lease = registerScratchLease({ kind: 'session', id: getSessionId() } as never, targetPath, {
    cleanupPolicy: 'on-complete',
    recovery: `baseline worktree at ${sha}; remove with: git worktree remove --force ${targetPath}`,
  })

  return {
    ok: true,
    path: targetPath,
    revision: sha,
    leaseId: lease.leaseId,
    dispose: async () => {
      await execFileNoThrowWithCwd('git', ['worktree', 'remove', '--force', targetPath], { cwd: repoRoot })
      releaseScratchLease(lease.leaseId)
    },
  }
}

// ————— PR reference parsing —————

/** `http(s)://<host>/<owner>/<repo>/pull/<n>` (the path shape is GitHub-specific) or `#<n>`. */
export function parsePRReference(input: string): number | null {
  const urlMatch = input.match(/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/)
  if (urlMatch) return parseInt(urlMatch[1] as string, 10)
  const shortMatch = input.match(/^#(\d+)$/)
  if (shortMatch) return parseInt(shortMatch[1] as string, 10)
  return null
}

// ————— tmux helpers —————

export async function isTmuxAvailable(): Promise<boolean> {
  const result = await execFileNoThrowWithCwd('tmux', ['-V'], {})
  return result.code === 0
}

export function getTmuxInstallInstructions(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Install tmux with: brew install tmux'
    case 'linux':
      return 'Install tmux with: sudo apt install tmux (or: sudo dnf install tmux)'
    case 'win32':
      return 'tmux is not natively available on Windows; consider WSL or Cygwin'
    default:
      return 'Install tmux through your system package manager'
  }
}

export async function createTmuxSessionForWorktree(
  sessionName: string,
  worktreePath: string,
): Promise<{ created: boolean; error?: string }> {
  const result = await execFileNoThrowWithCwd('tmux', ['new-session', '-d', '-s', sessionName, '-c', worktreePath], {})
  if (result.code !== 0) {
    return { created: false, error: result.stderr.trim() }
  }
  return { created: true }
}

export async function killTmuxSession(sessionName: string): Promise<boolean> {
  const result = await execFileNoThrowWithCwd('tmux', ['kill-session', '-t', sessionName], {})
  return result.code === 0
}

/** Repository basename and branch joined by an underscore, `/` and `.` replaced by `_`. */
export function generateTmuxSessionName(repoPath: string, branch: string): string {
  return `${basename(repoPath)}_${branch}`.replace(/[/.]/g, '_')
}

// ————— the --worktree --tmux fast path —————

function runTmuxSync(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean }): {
  status: number
  stdout: string
} {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    // Hidden except when the child takes over this console (inherit —
    // attach): CREATE_NO_WINDOW would sever an interactive attach.
    windowsHide: options?.inherit !== true,
    ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    stdio: options?.inherit ? 'inherit' : ['ignore', 'pipe', 'ignore'],
    // Bounded on every probe/setup call; the interactive attach (inherit)
    // IS the operator's screen and must never be killed under them.
    ...(options?.inherit === true ? {} : { timeout: 15_000 }),
  })
  return { status: result.status ?? 1, stdout: typeof result.stdout === 'string' ? result.stdout : '' }
}

// The chords Mercury binds (contract data).

// A tiny, deliberately non-cryptographic word set, separate from the main
// slug generator.
const THROWAWAY_ADJECTIVES = ['quick', 'calm', 'brisk', 'quiet', 'bright', 'spare']
const THROWAWAY_NOUNS = ['lane', 'bench', 'desk', 'nook', 'yard', 'shed']

function throwawayWorktreeName(): string {
  const pick = (list: string[]): string => list[Math.floor(Math.random() * list.length)] as string
  const suffix = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `${pick(THROWAWAY_ADJECTIVES)}-${pick(THROWAWAY_NOUNS)}-${suffix}`
}

/**
 * The pre-CLI `--worktree --tmux` fast path. Every tmux invocation here is
 * SYNCHRONOUS — it runs before the full CLI loads.
 */
export async function execIntoTmuxWorktree(args: string[]): Promise<{ handled: boolean; error?: string }> {
  if (process.platform === 'win32') {
    return { handled: false, error: '--tmux is not supported on Windows' }
  }
  if (runTmuxSync(['-V']).status !== 0) {
    // Deliberately a TWO-branch hint (macOS/homebrew, everything else/apt),
    // not the exported four-branch instruction helper — routing through
    // the helper would change the message on Fedora/RHEL and unknown
    // platforms.
    const hint =
      process.platform === 'darwin' ? 'Install it with: brew install tmux' : 'Install it with: sudo apt install tmux'
    return { handled: false, error: `tmux is not installed. ${hint}` }
  }

  // Argument parsing.
  let requestedName: string | undefined
  let classicMode = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg === '-w' || arg === '--worktree') {
      const next = args[index + 1]
      if (next !== undefined && !next.startsWith('-')) requestedName = next
    } else if (arg.startsWith('--worktree=')) {
      requestedName = arg.slice('--worktree='.length)
    } else if (arg === '--tmux=classic') {
      classicMode = true
    }
  }

  let prNumber: number | undefined
  let slug: string
  if (requestedName !== undefined) {
    const parsedPr = parsePRReference(requestedName)
    if (parsedPr !== null) {
      prNumber = parsedPr
      slug = `pr-${parsedPr}`
    } else {
      slug = requestedName
    }
  } else {
    slug = throwawayWorktreeName()
  }

  try {
    validateWorktreeSlug(slug)
  } catch (error) {
    return { handled: false, error: `✕ ${error instanceof Error ? error.message : String(error)}` }
  }

  let worktreeDir: string
  let repoName: string
  if (hasWorktreeCreateHook()) {
    // Hook precedence mirrors session creation.
    try {
      const hookResult = await executeWorktreeCreateHook(slug)
      worktreeDir = hookResult.worktreePath
      repoName = basename(findCanonicalGitRoot(getCwd()) || getCwd())
      process.stdout.write(`Worktree: ${worktreeDir}\n`)
    } catch (error) {
      return { handled: false, error: error instanceof Error ? error.message : String(error) }
    }
  } else {
    const gitRoot = findCanonicalGitRoot(getCwd())
    if (!gitRoot) {
      return { handled: false, error: '--worktree requires a git repository' }
    }
    repoName = basename(gitRoot)
    try {
      const created = await createOrResumeWorktree(gitRoot, slug, prNumber !== undefined ? { prNumber } : undefined)
      worktreeDir = created.worktreePath
      if (!created.existed) {
        process.stdout.write(`Created worktree ${created.worktreePath} (based on ${created.baseBranch ?? 'HEAD'})\n`)
        await runPostCreationSetup(gitRoot, created.worktreePath)
      }
    } catch (error) {
      return { handled: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // The tmux session is named from the BRANCH name, not the raw slug.
  const tmuxSessionName = generateTmuxSessionName(repoName, worktreeBranchName(slug))

  // Relaunch arguments: the original list minus every worktree/tmux flag.
  const relaunchArgs: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg === '--tmux' || arg === '--tmux=classic' || arg.startsWith('--worktree=')) continue
    if (arg === '-w' || arg === '--worktree') {
      const next = args[index + 1]
      if (next !== undefined && !next.startsWith('-')) index++
      continue
    }
    relaunchArgs.push(arg)
  }

  const sessionExists = runTmuxSync(['has-session', '-t', tmuxSessionName]).status === 0
  const insideTmux = isInsideTmuxSync()
  // Control mode lets iTerm2 render tmux windows natively. From inside
  // tmux the relevant operation is moving the client, which control mode
  // does not express — the third condition is not a preference.
  const controlMode = isInITerm2() && !classicMode && !insideTmux

  // child-env law: raw base by design — tmux here relaunches Mercury itself.
  const childEnv: NodeJS.ProcessEnv = { ...process.env }

  if (controlMode && !sessionExists) {
    process.stdout.write(
      chalk.yellow('┌─ iTerm2 tip ─────────────────────────────────────────┐\n│ Set "Preferences > General > tmux > open tmux windows │\n│ as tabs in the attaching window" to open this session │\n│ as a tab instead of a new window.                     │\n└───────────────────────────────────────────────────────┘\n'),
    )
  }

  const relaunchCommand = [process.execPath, ...relaunchArgs]
  if (insideTmux) {
    // Never nest: switch the existing client, creating detached first when
    // needed. The control-mode global argument is not used on this branch.
    if (!sessionExists) {
      runTmuxSync(['new-session', '-d', '-s', tmuxSessionName, '-c', worktreeDir, '--', ...relaunchCommand], {
        env: childEnv,
      })
    }
    runTmuxSync(['switch-client', '-t', tmuxSessionName], { inherit: true })
  } else {
    const globalArgs = controlMode ? ['-CC'] : []
    runTmuxSync(
      [...globalArgs, 'new-session', '-A', '-s', tmuxSessionName, '-c', worktreeDir, '--', ...relaunchCommand],
      { env: childEnv, inherit: true },
    )
  }
  return { handled: true }
}
