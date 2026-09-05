import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { logForDebugging } from '../utils/debug.js'
import { gitExe } from '../utils/git.js'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { PROJECT_CONFIG_DIR_NAMES } from '../utils/projectConfig.js'
import { gitInitRefusal, projectScopePathspec } from '../utils/projectBoundary.js'
import { daemonDir } from './controlSocket.js'

export const WORKTREE_RUNTIME_HOMES: readonly string[] = PROJECT_CONFIG_DIR_NAMES

export function workerWorktreeRoot(dir: string = daemonDir()): string {
  return join(dir, 'worktrees')
}

export function workerWorktreePath(runnerId: string, dir?: string): string {
  return join(workerWorktreeRoot(dir), runnerId)
}

export function workspaceKindOf(workspaceId: string): 'git' | 'plain-folder' {
  try {
    statSync(join(workspaceId, '.git'))
    return 'git'
  } catch {
    return 'plain-folder'
  }
}

function git(
  cwd: string,
  ...args: string[]
): { ok: boolean; stdout: string; stderr: string; unavailable?: boolean } {
  const res = spawnSync(gitExe(), ['-C', cwd, ...args], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...subprocessEnv(), GIT_OPTIONAL_LOCKS: '0' },
  })
  if (res.error) {
    return {
      ok: false,
      stdout: '',
      stderr: `git unavailable: ${String((res.error as Error).message ?? res.error)}`.slice(0, 400),
      unavailable: true,
    }
  }
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? '',
    stderr: (res.stderr ?? '').slice(0, 400),
  }
}

async function gitAsync(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string; unavailable?: boolean }> {
  return await new Promise(resolveDone => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(gitExe(), ['-C', cwd, ...args], {
        windowsHide: true,
        env: { ...subprocessEnv(), GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolveDone({
        ok: false,
        stdout: '',
        stderr: `git unavailable: ${String((err as Error)?.message ?? err)}`.slice(0, 400),
        unavailable: true,
      })
      return
    }
    let out = ''
    let errText = ''
    let settled = false
    const finish = (r: { ok: boolean; stdout: string; stderr: string; unavailable?: boolean }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveDone(r)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
      }
      finish({ ok: false, stdout: out, stderr: 'git timed out after 30s' })
    }, 30_000)
    timer.unref?.()
    child.stdout?.on('data', d => {
      out += String(d)
    })
    child.stderr?.on('data', d => {
      errText += String(d)
    })
    child.on('error', err => {
      finish({
        ok: false,
        stdout: '',
        stderr: `git unavailable: ${String((err as Error)?.message ?? err)}`.slice(0, 400),
        unavailable: true,
      })
    })
    child.on('close', code => {
      finish({ ok: code === 0, stdout: out, stderr: errText.slice(0, 400) })
    })
  })
}

export type WorktreeEnsureResult =
  | { ok: true; path: string; created: boolean; branchName?: string; base?: string }
  | {
      ok: false
      code: 'no-repository' | 'git-unavailable' | 'unborn-head' | 'worktree-create-failed'
      error: string
    }

function forkBaseRef(workspaceId: string): string {
  for (const ref of ['refs/heads/main', 'refs/heads/master']) {
    if (git(workspaceId, 'rev-parse', '--verify', '--quiet', ref).ok) return ref
  }
  return 'HEAD'
}

export async function ensureWorkerWorktree(
  workspaceId: string,
  runnerId: string,
  dir?: string,
  opts?: { branchName?: string },
): Promise<WorktreeEnsureResult> {
  if (workspaceKindOf(workspaceId) === 'plain-folder') {
    const refusal = gitInitRefusal(workspaceId)
    if (refusal !== null) {
      return {
        ok: false,
        code: 'worktree-create-failed',
        error: `forking needs a git repository, and Mercury will not start one in ${workspaceId} — ${refusal.words}; launch it without a worktree`,
      }
    }
    return {
      ok: false,
      code: 'no-repository',
      error: `forking needs a git repository — ${workspaceId} has none yet`,
    }
  }
  let path: string | null = null
  const candidates = [runnerId, ...[2, 3, 4, 5, 6].map(n => `${runnerId}-${n}`)].map(id =>
    workerWorktreePath(id, dir),
  )
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      path = candidate
      break
    }
    if (existsSync(join(candidate, '.git'))) {
      const common = git(candidate, 'rev-parse', '--git-common-dir')
      let belongsHere = false
      if (common.ok) {
        try {
          const commonDir = resolve(candidate, common.stdout.trim())
          belongsHere = realpathSync(dirname(commonDir)) === realpathSync(workspaceId)
        } catch {
          belongsHere = false
        }
      }
      const head = git(candidate, 'rev-parse', '--abbrev-ref', 'HEAD')
      const onBranch = head.ok && head.stdout.trim() !== 'HEAD' ? head.stdout.trim() : undefined
      const branchMatches = opts?.branchName === undefined || onBranch === opts.branchName
      if (belongsHere && branchMatches) {
        return {
          ok: true,
          path: candidate,
          created: false,
          ...(onBranch !== undefined ? { branchName: onBranch } : {}),
        }
      }
      continue
    }
    try {
      rmSync(candidate, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, code: 'worktree-create-failed', error: `partial worktree unremovable: ${err}` }
    }
    path = candidate
    break
  }
  if (path === null) {
    return {
      ok: false,
      code: 'worktree-create-failed',
      error: 'every candidate worktree slot holds a retained fork — merge or clear one first',
    }
  }
  const headProbe = git(workspaceId, 'rev-parse', '--verify', '--quiet', 'HEAD')
  if (headProbe.unavailable === true) {
    return {
      ok: false,
      code: 'git-unavailable',
      error: 'git is not installed (or not on PATH) — forking needs git',
    }
  }
  if (!headProbe.ok) {
    const refusal = gitInitRefusal(workspaceId)
    if (refusal !== null) {
      return {
        ok: false,
        code: 'worktree-create-failed',
        error: `forking needs a commit, and Mercury will not make one in ${workspaceId} — ${refusal.words}; launch it without a worktree`,
      }
    }
    return {
      ok: false,
      code: 'unborn-head',
      error: `no commits yet in ${workspaceId} — one base commit unlocks forking`,
    }
  }
  mkdirSync(workerWorktreeRoot(dir), { recursive: true })
  if (opts?.branchName !== undefined) {
    const base = forkBaseRef(workspaceId)
    const ladder = [opts.branchName, ...[2, 3, 4, 5, 6].map(n => `${opts.branchName}-${n}`)]
    const branchTaken = (name: string): boolean =>
      git(workspaceId, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`).ok
    const name = ladder.find(candidate => !branchTaken(candidate)) ?? `${opts.branchName}-${Date.now().toString(36)}`
    const add = await gitAsync(workspaceId, 'worktree', 'add', '-b', name, path, base)
    if (add.ok) return { ok: true, path, created: true, branchName: name, base }
    await gitAsync(workspaceId, 'worktree', 'prune')
    const retryName = /already exists/i.test(add.stderr) ? `${opts.branchName}-${Date.now().toString(36)}` : name
    const retry = await gitAsync(workspaceId, 'worktree', 'add', '-b', retryName, path, base)
    if (retry.ok) return { ok: true, path, created: true, branchName: retryName, base }
    return {
      ok: false,
      code: 'worktree-create-failed',
      error: `git worktree add failed: ${retry.stderr || add.stderr}`,
    }
  }
  const add = await gitAsync(workspaceId, 'worktree', 'add', '--detach', path)
  if (!add.ok) {
    await gitAsync(workspaceId, 'worktree', 'prune')
    const retry = await gitAsync(workspaceId, 'worktree', 'add', '--detach', path)
    if (!retry.ok) {
      return { ok: false, code: 'worktree-create-failed', error: `git worktree add failed: ${retry.stderr || add.stderr}` }
    }
  }
  return { ok: true, path, created: true }
}

export const FORK_BASE_COMMIT_SUBJECT = 'mercury: base commit — forking unlocked'

export function initGitRepository(folder: string): { ok: boolean; error?: string } {
  const refusal = gitInitRefusal(folder)
  if (refusal !== null) {
    return { ok: false, error: `Mercury will not start a repository in ${folder} — ${refusal.words}` }
  }
  if (workspaceKindOf(folder) === 'plain-folder') {
    const init = git(folder, 'init')
    if (!init.ok) {
      return {
        ok: false,
        error: init.unavailable === true ? 'git is not installed (or not on PATH)' : init.stderr || 'git init failed',
      }
    }
  }
  const head = git(folder, 'rev-parse', '--verify', '--quiet', 'HEAD')
  if (head.ok) return { ok: true }
  const commit = git(folder, 'commit', '--allow-empty', '-m', FORK_BASE_COMMIT_SUBJECT)
  if (!commit.ok) {
    return { ok: false, error: commit.stderr || 'the base commit failed (git user.name/email may be unset)' }
  }
  return { ok: true }
}

export type WorktreeDirt =
  | { kind: 'clean' }
  | { kind: 'runtime-only'; files: string[] }
  | { kind: 'authored'; files: string[] }

function dirtProbe(path: string): string[] {
  return ['status', '--porcelain', '--untracked-files=normal', ...projectScopePathspec(path)]
}

export function classifyWorktreeDirt(path: string): WorktreeDirt {
  return classifyStatusRows(git(path, ...dirtProbe(path)))
}

const DIRT_CACHE_FLOOR_MS = 60_000
const worktreeDirtCache = new Map<string, { at: number; dirt: WorktreeDirt | null; inFlight: Promise<void> | null }>()

export function cachedWorktreeDirt(path: string): WorktreeDirt | null {
  let entry = worktreeDirtCache.get(path)
  if (!entry) {
    entry = { at: 0, dirt: null, inFlight: null }
    worktreeDirtCache.set(path, entry)
  }
  if (entry.inFlight === null && Date.now() - entry.at >= DIRT_CACHE_FLOOR_MS) {
    const e = entry
    e.inFlight = gitAsync(path, ...dirtProbe(path))
      .then(res => {
        e.dirt = classifyStatusRows(res)
      })
      .catch(() => {
      })
      .finally(() => {
        e.at = Date.now()
        e.inFlight = null
      })
  }
  return entry.dirt
}

export function _worktreeDirtRefreshForTesting(path: string): Promise<void> {
  return worktreeDirtCache.get(path)?.inFlight ?? Promise.resolve()
}

function classifyStatusRows(status: { ok: boolean; stdout: string; stderr: string }): WorktreeDirt {
  if (!status.ok) {
    return { kind: 'authored', files: [`<unreadable: git status failed — ${status.stderr.slice(0, 120)}>`] }
  }
  const rows = status.stdout.split('\n').filter(Boolean)
  if (rows.length === 0) return { kind: 'clean' }
  const authored: string[] = []
  const runtime: string[] = []
  for (const row of rows) {
    const flags = row.slice(0, 2)
    const file = row.slice(3).replace(/^"|"$/g, '')
    const topSegment = file.split(/[\\/]/)[0] ?? file
    if (flags === '??' && WORKTREE_RUNTIME_HOMES.includes(topSegment)) runtime.push(file)
    else authored.push(file)
  }
  if (authored.length > 0) return { kind: 'authored', files: authored }
  return { kind: 'runtime-only', files: runtime }
}

export interface ForkCommitState {
  committedAhead: number | null
  dirt: WorktreeDirt | null
}

export function forkCommitState(
  workspaceId: string,
  branchName: string,
  worktreePath?: string,
): ForkCommitState {
  const base = forkBaseRef(workspaceId)
  const ahead = git(workspaceId, 'rev-list', '--count', `${base}..refs/heads/${branchName}`)
  const parsed = ahead.ok ? Number.parseInt(ahead.stdout.trim(), 10) : Number.NaN
  const committedAhead = Number.isFinite(parsed) ? parsed : null
  const dirt = worktreePath !== undefined && existsSync(worktreePath) ? classifyWorktreeDirt(worktreePath) : null
  return { committedAhead, dirt }
}

export function describeForkCommitState(state: ForkCommitState): string {
  const parts: string[] = []
  if (state.committedAhead === null) parts.push('commit count unknown')
  else if (state.committedAhead === 0) parts.push('nothing committed ahead of main')
  else parts.push(`${state.committedAhead} commit${state.committedAhead === 1 ? '' : 's'} ahead of main`)
  if (state.dirt === null) parts.push('worktree not on disk')
  else if (state.dirt.kind === 'authored') parts.push(`uncommitted changes in ${state.dirt.files.length} file${state.dirt.files.length === 1 ? '' : 's'}`)
  else parts.push('working tree clean')
  return parts.join(' · ')
}

export type WorktreeReapOutcome =
  | { outcome: 'reaped' }
  | { outcome: 'noop' }
  | { outcome: 'retained'; files: string[]; committedAhead?: number }

export function reapWorkerWorktree(
  workspaceId: string,
  runnerId: string,
  dir?: string,
  opts?: { branchName?: string; path?: string },
): WorktreeReapOutcome {
  const path = opts?.path ?? workerWorktreePath(runnerId, dir)
  if (!existsSync(path)) {
    git(workspaceId, 'worktree', 'prune')
    return { outcome: 'noop' }
  }
  let dirt: WorktreeDirt | undefined
  if (opts?.branchName !== undefined) {
    const state = forkCommitState(workspaceId, opts.branchName, path)
    dirt = state.dirt ?? undefined
    if (state.committedAhead !== null && state.committedAhead > 0) {
      return {
        outcome: 'retained',
        files: state.dirt?.kind === 'authored' ? state.dirt.files : [],
        committedAhead: state.committedAhead,
      }
    }
  }
  dirt ??= classifyWorktreeDirt(path)
  if (dirt.kind === 'authored') {
    logForDebugging(`[concourse/worktrees] RETAINED ${runnerId}: authored work present (${dirt.files.slice(0, 5).join(', ')}${dirt.files.length > 5 ? ', …' : ''})`)
    return { outcome: 'retained', files: dirt.files }
  }
  const remove = git(workspaceId, 'worktree', 'remove', '--force', path)
  if (!remove.ok) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (err) {
      logForDebugging(`[concourse/worktrees] reap of ${runnerId} could not remove dir: ${err}`)
    }
  }
  git(workspaceId, 'worktree', 'prune')
  return { outcome: 'reaped' }
}
