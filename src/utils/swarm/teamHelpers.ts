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
  isActive?: boolean
  mode?: PermissionMode
  role?: string
}

export type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  charter?: TeamCharter
  hiddenPaneIds?: string[]
  allowedPaths?: TeamAllowedPath[]
  governance?: {
    broadcastEnabled?: boolean
    broadcastFairness?: {
      repostCooldownMs?: number
      activeWindowMs?: number
    }
  }
  members: TeamMember[]
}


export function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
}

export function sanitizeAgentName(name: string): string {
  return name.replace(/@/g, '-')
}

export function getTeamDir(teamName: string): string {
  return join(getTeamsDir(), sanitizeName(teamName))
}

export function getTeamFilePath(teamName: string): string {
  return join(getTeamDir(teamName), 'config.json')
}


function parseTeamFile(raw: string): TeamFile {
  return JSON.parse(raw) as TeamFile
}

export function readTeamFile(teamName: string): TeamFile | null {
  try {
    return parseTeamFile(readFileSync(getTeamFilePath(teamName), 'utf-8'))
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }
}

export async function readTeamFileAsync(teamName: string): Promise<TeamFile | null> {
  try {
    return parseTeamFile(await readFile(getTeamFilePath(teamName), 'utf-8'))
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }
}

async function writeTeamFileAtomic(path: string, teamFile: TeamFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await durableAtomicPublish(path, jsonStringify(teamFile, null, 2))
}

function writeTeamFileAtomicSync(path: string, teamFile: TeamFile): void {
  durableAtomicPublishSync(path, jsonStringify(teamFile, null, 2))
}

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


const LOCK_OPTIONS = {
  retries: { retries: 20, minTimeout: 5, maxTimeout: 100 },
}

const compromisedTeamLocks = new Set<string>()

const teamFileLanes = new Map<string, GroupCommitLane<TeamFile | null>>()

function laneFor(teamName: string): GroupCommitLane<TeamFile | null> {
  const path = getTeamFilePath(teamName)
  let lane = teamFileLanes.get(path)
  if (lane !== undefined) return lane
  lane = groupCommitLane<TeamFile | null>({
    acquire: async () => {
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

function sleepSyncMs(ms: number): void {
  try {
    const shared = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(shared, 0, 0, ms)
  } catch {
  }
}

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
    }
  }
}


const MAX_TEAM_MEMBERS = 16

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

export function addHiddenPaneId(teamName: string, paneId: string): boolean {
  return withLockedTeamFileSync(teamName, current => {
    if (current === null) return { next: null, result: false }
    const hidden = current.hiddenPaneIds ?? []
    if (hidden.includes(paneId)) return { next: null, result: true }
    return { next: { ...current, hiddenPaneIds: [...hidden, paneId] }, result: true }
  })
}

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

export function removeMemberByAgentId(team: string, id: string): boolean {
  return withLockedTeamFileSync(team, current => {
    if (current === null) return { next: null, result: false }
    const surviving = current.members.filter(member => member.agentId !== id)
    if (surviving.length === current.members.length) return { next: null, result: false }
    return { next: { ...current, members: surviving }, result: true }
  })
}

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

export function syncTeammateMode(mode: PermissionMode, teamNameOverride?: string): void {
  if (!isTeammate()) return
  const teamName = teamNameOverride ?? getTeamName()
  const agentName = getAgentName()
  if (!teamName || !agentName) return
  setMemberMode(teamName, agentName, mode)
}

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
    member.isActive = isActive
    return { next: current, result: undefined }
  })
}


export function registerTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().add(teamName)
}

export function unregisterTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().delete(teamName)
}

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
