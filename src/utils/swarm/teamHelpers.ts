import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { z } from 'zod/v4'

import { getSessionCreatedTeams } from '../../bootstrap/state.js'
import { durableAtomicPublish, durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { groupCommitLane, type GroupCommitLane } from '../../substrate/groupCommit.js'
import { logForDebugging } from '../debug.js'
import { getTeamsDir } from '../envUtils.js'
import { errorMessage, getErrnoCode, isENOENT } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { gitExe } from '../git.js'
import { lazySchema } from '../lazySchema.js'
import * as lockfile from '../lockfile.js'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'
import { getTasksDir, notifyTasksUpdated } from '../tasks.js'
import { getAgentName, getTeamName, isTeammate } from '../teammate.js'
import type { PermissionMode } from '../../types/permissions.js'
import { TEAM_LEAD_NAME } from './constants.js'
import type { TeamCharter } from './teamCharter.js'
import type { BackendType } from './backends/types.js'
import { isPaneBackend } from './backends/types.js'

/**
 * The team roster file store: `<teams-dir>/<sanitized-team>/config.json`
 * (contract data — every Mercury process in the team reads this path). The
 * roster is a cross-process shared structure, so every read-modify-write is
 * serialised through a per-path group-commit lane and every publish is
 * atomic; lock-free readers can then never observe a torn file.
 *
 * NOTE the teams root comes from the shared resolver (`getTeamsDir`,
 * honouring `MERCURY_TEAMS_DIR`) — not from any `~/.claude/...` spelling.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A team-wide allowed path: absolute directory, tool, who added it, when. */
export type TeamAllowedPath = {
  path: string
  toolName: string
  addedBy: string
  addedAt: number
}

type TeamMember = {
  agentId: string
  name: string
  agentType?: string
  model?: string
  prompt?: string
  color?: string
  planModeRequired?: boolean
  joinedAt: number
  tmuxPaneId: string
  cwd: string
  worktreePath?: string
  sessionId?: string
  subscriptions: string[]
  backendType?: BackendType
  /** `false` = idle; absent or `true` = active. */
  isActive?: boolean
  mode?: PermissionMode
  /** Optional command role (e.g. room-commander). */
  role?: string
}

/**
 * The on-disk roster (contract data — old files lacking charter/governance/
 * role must keep parsing, which is why reads apply no schema).
 */
export type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  /** Stored so the team is discoverable from the session. */
  leadSessionId?: string
  charter?: TeamCharter
  hiddenPaneIds?: string[]
  allowedPaths?: TeamAllowedPath[]
  /** Absent ⇒ default behaviour: broadcasts allowed, flat lead→teammate authority. */
  governance?: {
    broadcastEnabled?: boolean
    broadcastFairness?: {
      repostCooldownMs?: number
      activeWindowMs?: number
    }
  }
  members: TeamMember[]
}

// ---------------------------------------------------------------------------
// Names and paths
// ---------------------------------------------------------------------------

/** Every character outside [A-Za-z0-9] becomes `-`, then lowercase. */
export function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
}

/** `@` becomes `-`, so an agent name can never make `name@team` ambiguous. */
export function sanitizeAgentName(name: string): string {
  return name.replace(/@/g, '-')
}

export function getTeamDir(teamName: string): string {
  return join(getTeamsDir(), sanitizeName(teamName))
}

export function getTeamFilePath(teamName: string): string {
  return join(getTeamDir(teamName), 'config.json')
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

function parseTeamFile(raw: string): TeamFile {
  // Deliberately no schema validation: an out-of-shape roster is returned
  // as-is rather than rejected (old writers must keep parsing).
  return JSON.parse(raw) as TeamFile
}

/** Lock-free sync read: missing ⇒ null silently; other errors log and yield null. */
export function readTeamFile(teamName: string): TeamFile | null {
  try {
    return parseTeamFile(readFileSync(getTeamFilePath(teamName), 'utf-8'))
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }
}

/** Lock-free async read with the same semantics. */
export async function readTeamFileAsync(teamName: string): Promise<TeamFile | null> {
  try {
    return parseTeamFile(await readFile(getTeamFilePath(teamName), 'utf-8'))
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }
}

/** The atomic publish every roster write goes through (durable primitive). */
async function writeTeamFileAtomic(path: string, teamFile: TeamFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await durableAtomicPublish(path, jsonStringify(teamFile, null, 2))
}

function writeTeamFileAtomicSync(path: string, teamFile: TeamFile): void {
  durableAtomicPublishSync(path, jsonStringify(teamFile, null, 2))
}

/**
 * Plain async write. The `exclusive` option uses the create-only flag so the
 * write fails with an already-exists error when the file is present —
 * first-writer-wins semantics for team creation, surfaced by the caller as
 * its typed precondition error.
 */
export async function writeTeamFileAsync(
  teamName: string,
  teamFile: TeamFile,
  opts?: { exclusive?: boolean },
): Promise<void> {
  const path = getTeamFilePath(teamName)
  await mkdir(dirname(path), { recursive: true })
  if (opts?.exclusive) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, jsonStringify(teamFile, null, 2), { flag: 'wx' })
    return
  }
  await durableAtomicPublish(path, jsonStringify(teamFile, null, 2))
}

// ---------------------------------------------------------------------------
// The locked mutation lanes
// ---------------------------------------------------------------------------

/** Lock retry budget: ~20 retries, 5 ms minimum, 100 ms maximum backoff. */
const LOCK_OPTIONS = {
  retries: { retries: 20, minTimeout: 5, maxTimeout: 100 },
}

/**
 * Paths whose lock was reported compromised (the holder stalled past its
 * lease and the lock was stolen). A batch that saw its lock compromised must
 * REFUSE to publish — publishing a lost update as success is forbidden. The
 * marker is cleared each time the lock is re-acquired.
 */
const compromisedTeamLocks = new Set<string>()

const teamFileLanes = new Map<string, GroupCommitLane<TeamFile | null>>()

function laneFor(teamName: string): GroupCommitLane<TeamFile | null> {
  const path = getTeamFilePath(teamName)
  let lane = teamFileLanes.get(path)
  if (lane !== undefined) return lane
  lane = groupCommitLane<TeamFile | null>({
    acquire: async () => {
      // The lock library requires the target to exist: an absent roster runs
      // the mutation unlocked (there is nothing to protect; a mutation that
      // throws on a missing roster behaves identically), and a file that
      // vanishes between the existence check and the acquisition falls back
      // to the unlocked path too.
      if (!existsSync(path)) return async () => {}
      try {
        const release = await lockfile.lock(path, {
          ...LOCK_OPTIONS,
          onCompromised: () => {
            compromisedTeamLocks.add(path)
          },
        })
        compromisedTeamLocks.delete(path)
        return release
      } catch (error) {
        if (isENOENT(error)) return async () => {}
        throw error
      }
    },
    read: async () => {
      let value: TeamFile | null = null
      try {
        value = parseTeamFile(await readFile(path, 'utf-8'))
      } catch (error) {
        if (!isENOENT(error)) logError(error)
      }
      return { value, context: undefined }
    },
    beforePublish: () => {
      if (compromisedTeamLocks.has(path)) {
        throw new Error(
          `The lock on ${path} was compromised while the roster was being mutated — the update was NOT published; retry the operation`,
        )
      }
    },
    publish: async next => {
      if (next === null) return
      await writeTeamFileAtomic(path, next)
    },
  })
  teamFileLanes.set(path, lane)
  return lane
}

/**
 * Serialised read-modify-write. Mutations arriving while a critical section
 * is busy are batched per roster path (lock once, read once, apply each in
 * arrival order, write once). A mutation reporting null publishes nothing; a
 * mutation that reports a roster is always written — including when it
 * mutated the object in place, which is why a same-reference result is
 * re-wrapped as a fresh reference before it reaches the lane's
 * identity-based skip. Mutations are non-reentrant: a body must not call
 * another locked helper for the same team.
 */
async function withLockedTeamFile<R>(
  teamName: string,
  mutate: (
    current: TeamFile | null,
  ) => { next: TeamFile | null; result: R } | Promise<{ next: TeamFile | null; result: R }>,
): Promise<R> {
  return laneFor(teamName).submit(async current => {
    const { next, result } = await mutate(current)
    const published = next !== null && Object.is(next, current) ? { ...next } : next
    return { next: published, result }
  })
}

/** A true sleep without a CPU spin; degrades to no wait when unavailable. */
function sleepSyncMs(ms: number): void {
  try {
    const shared = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(shared, 0, 0, ms)
  } catch {
    // No wait at all.
  }
}

/**
 * The synchronous variant for render-path callers. The sync lock forbids
 * retries, so a "locked" error gets a bounded manual backoff (up to 20
 * attempts, ~8 ms apart); on exhaustion — or any lock error at all — the
 * mutation proceeds UNLOCKED rather than throwing, because several callers
 * run from React render paths and from mode syncing, where a throw would
 * surface in render. Only a genuinely missing file is silent; other lock
 * errors are logged with the errno.
 */
function withLockedTeamFileSync<R>(
  teamName: string,
  mutate: (current: TeamFile | null) => { next: TeamFile | null; result: R },
): R {
  const path = getTeamFilePath(teamName)
  let release: (() => void) | null = null
  if (existsSync(path)) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        release = lockfile.lockSync(path)
        break
      } catch (error) {
        const code = getErrnoCode(error)
        if (code === 'ELOCKED') {
          sleepSyncMs(8)
          continue
        }
        if (!isENOENT(error)) {
          logForDebugging(
            `team roster sync lock failed (${code ?? 'unknown'}) — proceeding unlocked`,
          )
        }
        break
      }
    }
  }
  try {
    let current: TeamFile | null = null
    try {
      current = parseTeamFile(readFileSync(path, 'utf-8'))
    } catch (error) {
      if (!isENOENT(error)) logError(error)
    }
    const { next, result } = mutate(current)
    if (next !== null) writeTeamFileAtomicSync(path, next)
    return result
  } finally {
    try {
      release?.()
    } catch {
      // Releasing a lock we no longer own throws; the mutation already has
      // its own outcome.
    }
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Teammate recursion is blocked elsewhere; the cap stops an autonomous lead fanning out unbounded. */
const MAX_TEAM_MEMBERS = 16

/**
 * Append a member (async lock). Throws when the team does not exist and when
 * the roster is full — the cap is checked INSIDE the lock, because a
 * pre-lock check races: two concurrent spawns can both observe room and both
 * append.
 */
export async function appendTeamMember(teamName: string, member: TeamMember): Promise<void> {
  await withLockedTeamFile(teamName, current => {
    if (current === null) {
      throw new Error(`Team "${teamName}" does not exist — create the team first`)
    }
    if (current.members.length >= MAX_TEAM_MEMBERS) {
      throw new Error(
        `Team "${teamName}" already has ${current.members.length} members (max ${MAX_TEAM_MEMBERS}) — shut down an idle teammate before spawning another`,
      )
    }
    return { next: { ...current, members: [...current.members, member] }, result: undefined }
  })
}

/** Remove by agent id or display name (sync lock). */
export function removeTeammateFromTeamFile(
  teamName: string,
  identifier: { agentId?: string; name?: string },
): boolean {
  if (!identifier.agentId && !identifier.name) {
    logForDebugging('removeTeammateFromTeamFile: no identifier given')
    return false
  }
  return withLockedTeamFileSync(teamName, current => {
    if (current === null) {
      logForDebugging(`removeTeammateFromTeamFile: no roster for ${teamName}`)
      return { next: null, result: false }
    }
    const surviving = current.members.filter(
      member =>
        !(
          (identifier.agentId !== undefined && member.agentId === identifier.agentId) ||
          (identifier.name !== undefined && member.name === identifier.name)
        ),
    )
    if (surviving.length === current.members.length) {
      logForDebugging(`removeTeammateFromTeamFile: no member matched in ${teamName}`)
      return { next: null, result: false }
    }
    return { next: { ...current, members: surviving }, result: true }
  })
}

/** Idempotent hidden-pane add: already present ⇒ true without writing. */
export function addHiddenPaneId(teamName: string, paneId: string): boolean {
  return withLockedTeamFileSync(teamName, current => {
    if (current === null) return { next: null, result: false }
    const hidden = current.hiddenPaneIds ?? []
    if (hidden.includes(paneId)) return { next: null, result: true }
    return { next: { ...current, hiddenPaneIds: [...hidden, paneId] }, result: true }
  })
}

/** Idempotent hidden-pane remove: already absent ⇒ true without writing. */
export function removeHiddenPaneId(teamName: string, paneId: string): boolean {
  return withLockedTeamFileSync(teamName, current => {
    if (current === null) return { next: null, result: false }
    const hidden = current.hiddenPaneIds ?? []
    if (!hidden.includes(paneId)) return { next: null, result: true }
    return {
      next: { ...current, hiddenPaneIds: hidden.filter(id => id !== paneId) },
      result: true,
    }
  })
}

/** Remove a member by pane id, also dropping the pane from the hidden list. */
export function removeMemberFromTeam(teamName: string, paneId: string): boolean {
  return withLockedTeamFileSync(teamName, current => {
    if (current === null) return { next: null, result: false }
    const surviving = current.members.filter(member => member.tmuxPaneId !== paneId)
    if (surviving.length === current.members.length) return { next: null, result: false }
    return {
      next: {
        ...current,
        members: surviving,
        ...(current.hiddenPaneIds !== undefined
          ? { hiddenPaneIds: current.hiddenPaneIds.filter(id => id !== paneId) }
          : {}),
      },
      result: true,
    }
  })
}

/** Remove a member by agent id (in-process teammates all share a pane id). */
export function removeMemberByAgentId(team: string, id: string): boolean {
  return withLockedTeamFileSync(team, current => {
    if (current === null) return { next: null, result: false }
    const surviving = current.members.filter(member => member.agentId !== id)
    if (surviving.length === current.members.length) return { next: null, result: false }
    return { next: { ...current, members: surviving }, result: true }
  })
}

/**
 * Set one member's permission mode (matched by display name). An unchanged
 * value returns true WITHOUT writing; otherwise the members array is rebuilt
 * immutably and the roster written as a fresh object.
 */
export function setMemberMode(teamName: string, memberName: string, mode: PermissionMode): boolean {
  return withLockedTeamFileSync(teamName, current => {
    if (current === null) return { next: null, result: false }
    const member = current.members.find(candidate => candidate.name === memberName)
    if (member === undefined) {
      logForDebugging(`setMemberMode: no member ${memberName} in ${teamName}`)
      return { next: null, result: false }
    }
    if (member.mode === mode) return { next: null, result: true }
    return {
      next: {
        ...current,
        members: current.members.map(candidate =>
          candidate.name === memberName ? { ...candidate, mode } : candidate,
        ),
      },
      result: true,
    }
  })
}

/** One atomic pass; members not named or already at the mode are untouched. */
export function setMultipleMemberModes(
  teamName: string,
  updates: Array<{ memberName: string; mode: PermissionMode }>,
): boolean {
  return withLockedTeamFileSync(teamName, current => {
    if (current === null) return { next: null, result: false }
    const requestedByName = new Map(updates.map(update => [update.memberName, update.mode]))
    let changed = false
    const members = current.members.map(member => {
      const requested = requestedByName.get(member.name)
      if (requested === undefined || member.mode === requested) return member
      changed = true
      return { ...member, mode: requested }
    })
    if (!changed) return { next: null, result: true }
    return { next: { ...current, members }, result: true }
  })
}

/**
 * Sync the current teammate's own mode into the roster: a no-op unless this
 * process IS a teammate, resolving the team from the override or ambient
 * identity and the agent name from ambient identity.
 */
export function syncTeammateMode(mode: PermissionMode, teamNameOverride?: string): void {
  if (!isTeammate()) return
  const teamName = teamNameOverride ?? getTeamName()
  const agentName = getAgentName()
  if (!teamName || !agentName) return
  setMemberMode(teamName, agentName, mode)
}

/** Set a member's active flag (async lock); unchanged ⇒ no write. */
export async function setMemberActive(
  teamName: string,
  memberName: string,
  isActive: boolean,
): Promise<void> {
  await withLockedTeamFile(teamName, current => {
    if (current === null) {
      logForDebugging(`setMemberActive: no roster for ${teamName}`)
      return { next: null, result: undefined }
    }
    const member = current.members.find(candidate => candidate.name === memberName)
    if (member === undefined) {
      logForDebugging(`setMemberActive: no member ${memberName} in ${teamName}`)
      return { next: null, result: undefined }
    }
    if (member.isActive === isActive) return { next: null, result: undefined }
    // Mutated in place; the locked wrapper republishes it as a fresh
    // reference so the lane's identity skip does not swallow the write.
    member.isActive = isActive
    return { next: current, result: undefined }
  })
}

// ---------------------------------------------------------------------------
// Session-scoped cleanup
// ---------------------------------------------------------------------------

/** Registered in bootstrap state so test resets clear it (no cross-test leak). */
export function registerTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().add(teamName)
}

/** Explicit deletion unregisters, so shutdown does not try again. */
export function unregisterTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().delete(teamName)
}

/**
 * Shutdown cleanup: FIRST best-effort kill each team's pane-backed teammate
 * panes, THEN delete each team's directories. Killing first matters: an
 * interrupted lead leaves teammate processes running, and removing their
 * directories alone would leave them alive in panes nobody owns. (The
 * explicit team-delete path does not need the kill — by then teammates have
 * exited gracefully and the inbox poller has closed their panes.)
 */
export async function cleanupSessionTeams(): Promise<void> {
  const teams = [...getSessionCreatedTeams()]
  if (teams.length === 0) return
  await Promise.all(
    teams.map(teamName =>
      killTeamPanes(teamName).catch(error => {
        logForDebugging(`session cleanup: pane kill for ${teamName} failed: ${errorMessage(error)}`)
      }),
    ),
  )
  await Promise.all(
    teams.map(teamName =>
      cleanupTeamDirectories(teamName).catch(error => {
        logForDebugging(
          `session cleanup: directory cleanup for ${teamName} failed: ${errorMessage(error)}`,
        )
      }),
    ),
  )
  getSessionCreatedTeams().clear()
}

/**
 * Kill a team's pane-backed teammate panes. The backend registry and
 * detection modules are imported dynamically so they never enter this
 * module's static dependency graph — this only runs at shutdown.
 */
async function killTeamPanes(teamName: string): Promise<void> {
  const roster = readTeamFile(teamName)
  if (roster === null) return
  const paneMembers = roster.members.filter(
    member =>
      member.name !== TEAM_LEAD_NAME &&
      member.tmuxPaneId !== '' &&
      member.backendType !== undefined &&
      isPaneBackend(member.backendType),
  )
  if (paneMembers.length === 0) return

  const registry = await import('./backends/registry.js')
  const detection = await import('./backends/detection.js')
  await registry.ensureBackendsRegistered()
  const useExternalSocket = !detection.isInsideTmuxSync()
  for (const member of paneMembers) {
    try {
      const backend = registry.getBackendByType(member.backendType as 'tmux' | 'iterm2')
      const killed = await backend.killPane(member.tmuxPaneId, useExternalSocket)
      logForDebugging(
        `session cleanup: kill pane ${member.tmuxPaneId} (${member.name}) → ${killed}`,
      )
    } catch (error) {
      logForDebugging(
        `session cleanup: kill pane ${member.tmuxPaneId} failed: ${errorMessage(error)}`,
      )
    }
  }
}

/**
 * Destroy one worktree: locate the main repository through the worktree's
 * git pointer file (its `gitdir:` line names the repo's per-worktree git
 * directory; the repository root is two levels above it plus its parent) and
 * run `git worktree remove --force`; a "not a working tree" stderr means it
 * is already gone. Everything else — including an unreadable pointer — falls
 * back to a recursive force delete. All errors are logged only, so a
 * non-existent path is safe.
 */
async function destroyWorktree(worktreePath: string): Promise<void> {
  try {
    let repoRoot: string | null = null
    try {
      const pointer = await readFile(join(worktreePath, '.git'), 'utf-8')
      const match = pointer.match(/^gitdir:\s*(.+)$/m)
      if (match?.[1]) {
        const worktreeGitDir = match[1].trim()
        repoRoot = dirname(dirname(dirname(worktreeGitDir)))
      }
    } catch {
      repoRoot = null
    }
    if (repoRoot !== null) {
      const outcome = await execFileNoThrowWithCwd(
        gitExe(),
        ['worktree', 'remove', '--force', worktreePath],
        { cwd: repoRoot },
      )
      if (outcome.code === 0) return
      if (outcome.stderr.includes('not a working tree')) return
      logForDebugging(`worktree remove failed for ${worktreePath}: ${outcome.stderr}`)
    }
    await rm(worktreePath, { recursive: true, force: true })
  } catch (error) {
    logForDebugging(`worktree destruction failed for ${worktreePath}: ${errorMessage(error)}`)
  }
}

/**
 * Delete a team's directories: the roster is read BEFORE anything is
 * deleted, every member worktree is destroyed in sequence, then the team
 * directory goes, then the team's task directory keyed by the SANITIZED team
 * name — the spelling the lead's task-list registration uses; an in-process
 * teammate whose raw team name carries a capital or an underscore stores its
 * tasks under a differently keyed directory, which this cleanup does not
 * touch (risk R9). Task listeners are notified only when that removal
 * succeeded. Nothing throws.
 */
export async function cleanupTeamDirectories(teamName: string): Promise<void> {
  const roster = readTeamFile(teamName)
  const worktreePaths = (roster?.members ?? [])
    .map(member => member.worktreePath)
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
  for (const worktreePath of worktreePaths) {
    await destroyWorktree(worktreePath)
  }
  try {
    await rm(getTeamDir(teamName), { recursive: true, force: true })
  } catch (error) {
    logForDebugging(`team directory removal failed for ${teamName}: ${errorMessage(error)}`)
  }
  try {
    await rm(getTasksDir(sanitizeName(teamName)), { recursive: true, force: true })
    notifyTasksUpdated()
  } catch (error) {
    logForDebugging(`team task directory removal failed for ${teamName}: ${errorMessage(error)}`)
  }
}

// ---------------------------------------------------------------------------
// Legacy tool surface (kept for compatibility)
// ---------------------------------------------------------------------------

export const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum(['spawnTeam', 'cleanup'])
      .describe('The team operation to perform: spawn a team or clean one up'),
    agent_type: z.string().optional().describe('The agent type for spawned teammates'),
    team_name: z.string().optional().describe('The team name'),
    description: z.string().optional().describe('A description of the team'),
  }),
)

export type Input = z.infer<ReturnType<typeof inputSchema>>

export type SpawnTeamOutput = {
  operation: 'spawnTeam'
  success: boolean
  teamName?: string
  error?: string
}

export type CleanupOutput = {
  operation: 'cleanup'
  success: boolean
  error?: string
}

export type Output = SpawnTeamOutput | CleanupOutput
