// ============================================================================
//  concourseWorktrees — the worker worktree lifecycle
// (the worktree rows).
//
//  The supervisor's SIBLING, not a parallel subsystem: admission calls
//  `ensureWorkerWorktree` when a claim is 'worktree-isolated' (the worker's
//  cwd becomes the worktree; the CLAIM keeps the canonical repository root),
//  and settle/reconcile call `reapWorkerWorktree`. This module owns ONLY the
//  git mechanics + the dirt law — records and collision evidence stay at the
//  supervisor (one records owner, no import cycle).
//
//  THE DIRT LAW: before any reap
//  the worktree classifies through ONE closed rule — untracked files whose
//  top path segment is the Mercury runtime home ('.mercury') are RUNTIME
//  artifacts and can never keep a worktree alive
//  everything else — any tracked modification, any other untracked
//  path — is AUTHORED work and can never be reaped: the worktree is
//  RETAINED and the caller records typed evidence. A worktree git cannot
//  read classifies AUTHORED (conservative: never destroy what you cannot
//  prove empty).
//
//  Idempotency: ensure is keyed on the worktree dir — a crash
//  between `git worktree add` and the record publish re-ensures onto the
//  existing dir (a dir WITH `.git` is a finished create and is reused; a
//  partial dir WITHOUT `.git` never hosted a worker — no authored work can
//  exist — and is recreated). Reap of a missing dir is a noop; `git
//  worktree prune` sweeps the registration either way.
// ============================================================================
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { logForDebugging } from '../utils/debug.js'
import { gitExe } from '../utils/git.js'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { PROJECT_CONFIG_DIR_NAMES } from '../utils/projectConfig.js'
import { daemonDir } from './controlSocket.js'

/** Untracked-file roots that are Mercury RUNTIME state, never authored work.
 *  CLOSED list — the canonical home names from the ONE projectConfig seam. */
export const WORKTREE_RUNTIME_HOMES: readonly string[] = PROJECT_CONFIG_DIR_NAMES

export function workerWorktreeRoot(dir: string = daemonDir()): string {
  return join(dir, 'worktrees')
}

export function workerWorktreePath(runnerId: string, dir?: string): string {
  return join(workerWorktreeRoot(dir), runnerId)
}

/** Typed workspace capability: a `.git`
 *  entry (dir for a checkout, FILE for a linked worktree) makes a workspace
 *  'git'; anything else is an honest plain folder — git-only actions refuse
 *  typed instead of faking. */
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
  // env passed EXPLICITLY: under bun, process.env MUTATIONS do not reach
  // spawnSync children implicitly — the spread reads the live values, so
  // hermetic provers' config pins (GIT_CONFIG_GLOBAL/XDG) actually apply.
  // The base is the scrubbed child env (session tokens never ride).
  // The RESOLVED git (memoized PATH walk paid once per process): the sync
  // probe calls here are 5-20 ms each and 17 sites deep per worktree
  // ensure/reap — the per-spawn PATH re-walk was a real fraction of them.
  const res = spawnSync(gitExe(), ['-C', cwd, ...args], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...subprocessEnv() },
  })
  if (res.error) {
    // spawn failure (ENOENT — git not installed/on PATH)
    // would otherwise read as an EMPTY stderr refusal; it is its own typed truth.
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

/** SB-C9 (close audit): the ASYNC twin for the carve's long pole — a cold
 *  `git worktree add` can take seconds, and running it through spawnSync
 *  froze the daemon's event loop (pings timed out; the crew client's
 *  clearance condemned a live daemon). Probes stay sync (millisecond
 *  metadata reads); only the add/prune legs ride this. */
async function gitAsync(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string; unavailable?: boolean }> {
  return await new Promise(resolveDone => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(gitExe(), ['-C', cwd, ...args], {
        windowsHide: true,
        env: { ...subprocessEnv() },
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
        /* already gone */
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

/** The fork base: the latest LOCAL default-branch
 *  commit — a fork never inherits a sibling's half-done working tree. Falls
 *  back to HEAD when no main/master exists; the caller sees which. */
function forkBaseRef(workspaceId: string): string {
  for (const ref of ['refs/heads/main', 'refs/heads/master']) {
    if (git(workspaceId, 'rev-parse', '--verify', '--quiet', ref).ok) return ref
  }
  return 'HEAD'
}

/**
 * Create (or reuse) the isolated worktree for a worker. With
 * opts.branchName the worktree lands on its own named branch off
 * the latest local main — the ONE branch identity every surface reads from
 * the record; a name collision probes the -2..-6 ladder against git's real
 * branch list and last-resorts to a time-tailed unique name. Without it,
 * detached at HEAD (the pre-ruling contract, kept for explicit callers).
 */
export async function ensureWorkerWorktree(
  workspaceId: string,
  runnerId: string,
  dir?: string,
  opts?: { branchName?: string },
): Promise<WorktreeEnsureResult> {
  if (workspaceKindOf(workspaceId) === 'plain-folder') {
    return {
      ok: false,
      code: 'no-repository',
      error: `forking needs a git repository — ${workspaceId} has none yet`,
    }
  }
  // SB-C2 (close audit): a RETAINED worktree survives settle at this same
  // derived path, the short frees, and the next admission on the short used
  // to ADOPT the previous session's fork (its branch, its files — even a
  // different repo's linked tree). Reuse is legal only for THIS carve:
  // the survivor's git-common-dir must resolve into workspaceId and, in
  // branch mode, its HEAD must sit on the requested branch. A foreign
  // survivor stays untouched (retention IS the safety) and the carve moves
  // to a suffixed fresh path — the record's worktreePath is the one truth
  // the reap targets.
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
        // Reuse (crash between add and record publish): report the branch
        // the worktree actually sits on so the record stays the one truth.
        return {
          ok: true,
          path: candidate,
          created: false,
          ...(onBranch !== undefined ? { branchName: onBranch } : {}),
        }
      }
      continue // retained-foreign survivor — leave it, carve elsewhere
    }
    // Crash-mid-create: the dir exists but git never finished — no worker
    // ever ran here (no .git ⇒ no session), so recreating is safe.
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
  // The gate probes BEFORE any add: a missing git and an unborn HEAD are their
  // own honest refusals, never a truncated git hint-wall.
  const headProbe = git(workspaceId, 'rev-parse', '--verify', '--quiet', 'HEAD')
  if (headProbe.unavailable === true) {
    return {
      ok: false,
      code: 'git-unavailable',
      error: 'git is not installed (or not on PATH) — forking needs git',
    }
  }
  if (!headProbe.ok) {
    return {
      ok: false,
      code: 'unborn-head',
      error: `no commits yet in ${workspaceId} — one base commit unlocks forking`,
    }
  }
  mkdirSync(workerWorktreeRoot(dir), { recursive: true })
  if (opts?.branchName !== undefined) {
    const base = forkBaseRef(workspaceId)
    // COLLISION-PROOF BY CONSTRUCTION (the L19 fatal's sibling bug):
    // branches linger forever — a reap removes worktrees, never branches —
    // and the caller's record-based dedupe can forget, so the ladder is
    // probed against git's REAL branch list (sync millisecond metadata
    // reads, ≤6) and the first free name wins; an exhausted ladder mints a
    // time-tailed name no leftover can hold. The old shape retried the
    // FIRST name after the ladder — a name just proven taken — and died on
    // "a branch named '<x>' already exists" with free names to spare.
    const ladder = [opts.branchName, ...[2, 3, 4, 5, 6].map(n => `${opts.branchName}-${n}`)]
    const branchTaken = (name: string): boolean =>
      git(workspaceId, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`).ok
    const name = ladder.find(candidate => !branchTaken(candidate)) ?? `${opts.branchName}-${Date.now().toString(36)}`
    const add = await gitAsync(workspaceId, 'worktree', 'add', '-b', name, path, base)
    if (add.ok) return { ok: true, path, created: true, branchName: name, base }
    // A stale registration from a previous crash can block the add — prune
    // once and retry (idempotent recovery, never a loop); a branch that
    // out-raced the probe retries on a FRESH time-tailed name, never the
    // one just refused. What still fails here is truly unmintable (git
    // gone, base unreadable, path stuck) and the line says so honestly.
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
    // A stale registration from a previous crash can block the add — prune
    // once and retry (idempotent recovery, never a loop).
    await gitAsync(workspaceId, 'worktree', 'prune')
    const retry = await gitAsync(workspaceId, 'worktree', 'add', '--detach', path)
    if (!retry.ok) {
      return { ok: false, code: 'worktree-create-failed', error: `git worktree add failed: ${retry.stderr || add.stderr}` }
    }
  }
  return { ok: true, path, created: true }
}

/** the allowed git-init offer — initialize a plain
 *  folder (or give an unborn repo its base commit) so sessions can fork it.
 *  Idempotent; the base commit is empty and named so the operator can see
 *  exactly what was created. Never called without the operator's yes. */
export function initGitRepository(folder: string): { ok: boolean; error?: string } {
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
  const commit = git(folder, 'commit', '--allow-empty', '-m', 'mercury: base commit — forking unlocked')
  if (!commit.ok) {
    return { ok: false, error: commit.stderr || 'the base commit failed (git user.name/email may be unset)' }
  }
  return { ok: true }
}

export type WorktreeDirt =
  | { kind: 'clean' }
  | { kind: 'runtime-only'; files: string[] }
  | { kind: 'authored'; files: string[] }

/** The ONE classification rule. Unreadable ⇒ authored. */
export function classifyWorktreeDirt(path: string): WorktreeDirt {
  const status = git(path, 'status', '--porcelain')
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
    // Porcelain paths are /-spelled on every OS; the class split also accepts
    // \ so a stray native path can never dodge the runtime-home rule (win32
    // seam ratchet).
    const topSegment = file.split(/[\\/]/)[0] ?? file
    if (flags === '??' && WORKTREE_RUNTIME_HOMES.includes(topSegment)) runtime.push(file)
    else authored.push(file)
  }
  if (authored.length > 0) return { kind: 'authored', files: authored }
  return { kind: 'runtime-only', files: runtime }
}

/** A fork's commit state — the ONE read the reap decision and the
 *  coordinator's board both use to say what a branch holds (the
 *  "committed-ahead" truth + the dirt law). Bounded: three metadata probes,
 *  milliseconds each. `committedAhead` is null when the branch is absent or
 *  git cannot answer; `dirt` is null when the worktree path is absent. */
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

/** Plain words for a fork's commit state — one sentence every surface can
 *  quote ("2 commits ahead of main · uncommitted changes in 3 files"). */
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

/**
 * Reap a settled worker's worktree. Idempotent: a missing dir
 * is a noop. AUTHORED dirt refuses the reap and reports the exact files —
 * the CALLER records the typed retention evidence; the worktree stays for
 * the operator. A branch-mode worktree whose branch
 * sits AHEAD of the fork base is finished COMMITTED work — retained the
 * same way until its merge-back lands (retention IS the safety). Clean and
 * runtime-only worktrees remove + prune.
 */
export function reapWorkerWorktree(
  workspaceId: string,
  runnerId: string,
  dir?: string,
  opts?: { branchName?: string; path?: string },
): WorktreeReapOutcome {
  // SB-C2: the record's worktreePath is authoritative — suffixed carves
  // (retained-foreign survivors on the derived slot) reap the RIGHT dir.
  const path = opts?.path ?? workerWorktreePath(runnerId, dir)
  if (!existsSync(path)) {
    // Sweep any stale registration left by an out-of-band removal.
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
    // The registration may be gone (repo moved/pruned elsewhere) — the dirt
    // law already cleared authorship, so a direct removal is lawful.
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (err) {
      logForDebugging(`[concourse/worktrees] reap of ${runnerId} could not remove dir: ${err}`)
    }
  }
  git(workspaceId, 'worktree', 'prune')
  return { outcome: 'reaped' }
}
