import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { z } from 'zod/v4'

import { getSessionCreatedCrews } from '../../bootstrap/state.js'
import { durableAtomicPublish, durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { groupCommitLane, type GroupCommitLane } from '../../substrate/groupCommit.js'
import { recordRefusedDurableFile } from '../../substrate/storeRecovery.js'
import { logForDebugging } from '../debug.js'
import { getCrewsDir } from '../envUtils.js'
import { errorMessage, getErrnoCode, isENOENT } from '../errors.js'
import { lazySchema } from '../lazySchema.js'
import * as lockfile from '../lockfile.js'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'
import { getAgentName, getCrewName, isCrewmate } from '../crewmate.js'
import type { PermissionMode } from '../../types/permissions.js'
import { CREW_LEAD_NAME } from './constants.js'
import type { CrewCharter } from './crewCharter.js'
import type { BackendType } from './backends/types.js'
import { readRetiredCrewFile } from '../../migrations/retiredCrewSpellings.js'
import { getRetiredCrewsDir } from '../envUtils.js'


export type CrewAllowedPath = {
  path: string
  toolName: string
  addedBy: string
  addedAt: number
}

type CrewMember = {
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
  stoppedAt?: number
  mode?: PermissionMode
  role?: string
}

export type CrewFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  charter?: CrewCharter
  hiddenPaneIds?: string[]
  allowedPaths?: CrewAllowedPath[]
  governance?: {
    broadcastEnabled?: boolean
    broadcastFairness?: {
      repostCooldownMs?: number
      activeWindowMs?: number
    }
  }
  members: CrewMember[]
}


export function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
}

export function sanitizeAgentName(name: string): string {
  return name.replace(/@/g, '-')
}

export function getCrewDir(crewName: string): string {
  return join(getCrewsDir(), sanitizeName(crewName))
}

export function getCrewFilePath(crewName: string): string {
  return join(getCrewDir(crewName), 'config.json')
}

function readableCrewFilePath(crewName: string): string {
  const current = getCrewFilePath(crewName)
  if (existsSync(current)) return current
  const retired = getRetiredCrewsDir()
  if (retired === null) return current
  const old = join(retired, sanitizeName(crewName), 'config.json')
  return existsSync(old) ? old : current
}


function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(item => typeof item === 'string')
}

function isAbsentOr(v: unknown, holds: (value: unknown) => boolean): boolean {
  return v === undefined || holds(v)
}

function isCrewMember(v: unknown): v is CrewMember {
  return (
    isRecord(v) &&
    typeof v.agentId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.joinedAt === 'number' &&
    typeof v.tmuxPaneId === 'string' &&
    typeof v.cwd === 'string' &&
    isStringArray(v.subscriptions)
  )
}

function isCrewAllowedPath(v: unknown): v is CrewAllowedPath {
  return isRecord(v) && typeof v.path === 'string' && typeof v.toolName === 'string'
}

function isCrewFile(v: unknown): v is CrewFile {
  return (
    isRecord(v) &&
    typeof v.name === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.leadAgentId === 'string' &&
    Array.isArray(v.members) &&
    v.members.every(isCrewMember) &&
    isAbsentOr(v.description, x => typeof x === 'string') &&
    isAbsentOr(v.leadSessionId, x => typeof x === 'string') &&
    isAbsentOr(v.charter, isRecord) &&
    isAbsentOr(v.hiddenPaneIds, isStringArray) &&
    isAbsentOr(v.allowedPaths, x => Array.isArray(x) && x.every(isCrewAllowedPath)) &&
    isAbsentOr(v.governance, isRecord)
  )
}

const namedRosterFiles = new Set<string>()

function parseCrewFile(raw: string, path: string): CrewFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    nameRefusedRoster(path)
    throw error
  }
  if (isCrewFile(parsed)) return readRetiredCrewFile(parsed, CREW_LEAD_NAME)
  nameRefusedRoster(path)
  return null
}

function nameRefusedRoster(path: string): void {
  if (namedRosterFiles.has(path)) return
  namedRosterFiles.add(path)
  const reason = `${path} is not a decodable roster: left in place, reported`
  logForDebugging(`[crew-roster] ${reason}`, { level: 'warn' })
  void recordRefusedDurableFile({ store: 'crew-roster', path, reason })
}

export function readCrewFile(crewName: string): CrewFile | null {
  const path = readableCrewFilePath(crewName)
  try {
    return parseCrewFile(readFileSync(path, 'utf-8'), path)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }
}

export async function readCrewFileAsync(crewName: string): Promise<CrewFile | null> {
  const path = readableCrewFilePath(crewName)
  try {
    return parseCrewFile(await readFile(path, 'utf-8'), path)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }
}

export function crewRosterExists(crewName: string): boolean {
  return existsSync(readableCrewFilePath(crewName))
}

async function writeCrewFileAtomic(path: string, crewFile: CrewFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await durableAtomicPublish(path, jsonStringify(crewFile, null, 2))
}

function writeCrewFileAtomicSync(path: string, crewFile: CrewFile): void {
  durableAtomicPublishSync(path, jsonStringify(crewFile, null, 2))
}

export async function writeCrewFileAsync(
  crewName: string,
  crewFile: CrewFile,
  opts?: { exclusive?: boolean },
): Promise<void> {
  const path = getCrewFilePath(crewName)
  await mkdir(dirname(path), { recursive: true })
  if (opts?.exclusive) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, jsonStringify(crewFile, null, 2), { flag: 'wx' })
    return
  }
  await durableAtomicPublish(path, jsonStringify(crewFile, null, 2))
}


const LOCK_OPTIONS = {
  retries: { retries: 20, minTimeout: 5, maxTimeout: 100 },
}

const compromisedCrewLocks = new Set<string>()

const crewFileLanes = new Map<string, GroupCommitLane<CrewFile | null>>()

function laneFor(crewName: string): GroupCommitLane<CrewFile | null> {
  const path = getCrewFilePath(crewName)
  let lane = crewFileLanes.get(path)
  if (lane !== undefined) return lane
  lane = groupCommitLane<CrewFile | null>({
    acquire: async () => {
      if (!existsSync(path)) return async () => {}
      try {
        const release = await lockfile.lock(path, {
          ...LOCK_OPTIONS,
          onCompromised: () => {
            compromisedCrewLocks.add(path)
          },
        })
        compromisedCrewLocks.delete(path)
        return release
      } catch (error) {
        if (isENOENT(error)) return async () => {}
        throw error
      }
    },
    read: async () => {
      let value: CrewFile | null = null
      try {
        value = parseCrewFile(await readFile(path, 'utf-8'), path)
      } catch (error) {
        if (!isENOENT(error)) logError(error)
      }
      return { value, context: undefined }
    },
    beforePublish: () => {
      if (compromisedCrewLocks.has(path)) {
        throw new Error(
          `The lock on ${path} was compromised while the roster was being mutated — the update was NOT published; retry the operation`,
        )
      }
    },
    publish: async next => {
      if (next === null) return
      await writeCrewFileAtomic(path, next)
    },
  })
  crewFileLanes.set(path, lane)
  return lane
}

async function withLockedCrewFile<R>(
  crewName: string,
  mutate: (
    current: CrewFile | null,
  ) => { next: CrewFile | null; result: R } | Promise<{ next: CrewFile | null; result: R }>,
): Promise<R> {
  return laneFor(crewName).submit(async current => {
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

function withLockedCrewFileSync<R>(
  crewName: string,
  mutate: (current: CrewFile | null) => { next: CrewFile | null; result: R },
): R {
  const path = getCrewFilePath(crewName)
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
            `crew roster sync lock failed (${code ?? 'unknown'}) — proceeding unlocked`,
          )
        }
        break
      }
    }
  }
  try {
    let current: CrewFile | null = null
    try {
      current = parseCrewFile(readFileSync(path, 'utf-8'), path)
    } catch (error) {
      if (!isENOENT(error)) logError(error)
    }
    const { next, result } = mutate(current)
    if (next !== null) writeCrewFileAtomicSync(path, next)
    return result
  } finally {
    try {
      release?.()
    } catch {
    }
  }
}


const MAX_CREW_MEMBERS = 16

export async function appendCrewMember(crewName: string, member: CrewMember): Promise<void> {
  await withLockedCrewFile(crewName, async current => {
    const roster = current ?? (await import('../crew/crewBirth.js')).foundingRosterFor(crewName)
    if (roster === null) {
      throw new Error(`Crew "${crewName}" does not exist`)
    }
    const standing = roster.members.filter(candidate => candidate.agentId !== member.agentId || candidate.stoppedAt === undefined)
    if (standing.length >= MAX_CREW_MEMBERS) {
      throw new Error(
        `Crew "${crewName}" already has ${standing.length} members (max ${MAX_CREW_MEMBERS}) — shut down an idle crewmate before spawning another`,
      )
    }
    return { next: { ...roster, members: [...standing, member] }, result: undefined }
  })
}

export function crewmateStopped(member: Pick<CrewMember, 'stoppedAt'>): boolean {
  return member.stoppedAt !== undefined
}

export async function markMemberStopped(crewName: string, agentId: string, stoppedAt: number): Promise<boolean> {
  return withLockedCrewFile(crewName, current => {
    if (current === null) return { next: null, result: false }
    const member = current.members.find(candidate => candidate.agentId === agentId)
    if (member === undefined) return { next: null, result: false }
    const members = current.members.map(candidate => (candidate === member ? { ...candidate, isActive: false, stoppedAt } : candidate))
    return { next: { ...current, members }, result: true }
  })
}

export function removeCrewmateFromCrewFile(
  crewName: string,
  identifier: { agentId?: string; name?: string },
): boolean {
  if (!identifier.agentId && !identifier.name) {
    logForDebugging('removeCrewmateFromCrewFile: no identifier given')
    return false
  }
  return withLockedCrewFileSync(crewName, current => {
    if (current === null) {
      logForDebugging(`removeCrewmateFromCrewFile: no roster for ${crewName}`)
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
      logForDebugging(`removeCrewmateFromCrewFile: no member matched in ${crewName}`)
      return { next: null, result: false }
    }
    return { next: { ...current, members: surviving }, result: true }
  })
}

export function addHiddenPaneId(crewName: string, paneId: string): boolean {
  return withLockedCrewFileSync(crewName, current => {
    if (current === null) return { next: null, result: false }
    const hidden = current.hiddenPaneIds ?? []
    if (hidden.includes(paneId)) return { next: null, result: true }
    return { next: { ...current, hiddenPaneIds: [...hidden, paneId] }, result: true }
  })
}

export function removeHiddenPaneId(crewName: string, paneId: string): boolean {
  return withLockedCrewFileSync(crewName, current => {
    if (current === null) return { next: null, result: false }
    const hidden = current.hiddenPaneIds ?? []
    if (!hidden.includes(paneId)) return { next: null, result: true }
    return {
      next: { ...current, hiddenPaneIds: hidden.filter(id => id !== paneId) },
      result: true,
    }
  })
}

export function removeMemberFromCrew(crewName: string, paneId: string): boolean {
  return withLockedCrewFileSync(crewName, current => {
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

export async function removeMemberByAgentId(crew: string, id: string): Promise<boolean> {
  return withLockedCrewFile(crew, current => {
    if (current === null) return { next: null, result: false }
    const surviving = current.members.filter(member => member.agentId !== id)
    if (surviving.length === current.members.length) return { next: null, result: false }
    return { next: { ...current, members: surviving }, result: true }
  })
}

export function setMemberMode(crewName: string, memberName: string, mode: PermissionMode): boolean {
  return withLockedCrewFileSync(crewName, current => {
    if (current === null) return { next: null, result: false }
    const member = current.members.find(candidate => candidate.name === memberName)
    if (member === undefined) {
      logForDebugging(`setMemberMode: no member ${memberName} in ${crewName}`)
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
  crewName: string,
  updates: Array<{ memberName: string; mode: PermissionMode }>,
): boolean {
  return withLockedCrewFileSync(crewName, current => {
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

export function syncCrewmateMode(mode: PermissionMode, crewNameOverride?: string): void {
  if (!isCrewmate()) return
  const crewName = crewNameOverride ?? getCrewName()
  const agentName = getAgentName()
  if (!crewName || !agentName) return
  setMemberMode(crewName, agentName, mode)
}

export async function setMemberActive(
  crewName: string,
  memberName: string,
  isActive: boolean,
): Promise<void> {
  await withLockedCrewFile(crewName, current => {
    if (current === null) {
      logForDebugging(`setMemberActive: no roster for ${crewName}`)
      return { next: null, result: undefined }
    }
    const member = current.members.find(candidate => candidate.name === memberName)
    if (member === undefined) {
      logForDebugging(`setMemberActive: no member ${memberName} in ${crewName}`)
      return { next: null, result: undefined }
    }
    if (member.isActive === isActive) return { next: null, result: undefined }
    member.isActive = isActive
    return { next: current, result: undefined }
  })
}


export function registerCrewForSessionCleanup(crewName: string): void {
  getSessionCreatedCrews().add(crewName)
}

export function unregisterCrewForSessionCleanup(crewName: string): void {
  getSessionCreatedCrews().delete(crewName)
}

export async function cleanupSessionCrews(): Promise<void> {
  getSessionCreatedCrews().clear()
}


export const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum(['spawnCrew', 'cleanup'])
      .describe('The crew operation to perform: spawn a crew or clean one up'),
    agent_type: z.string().optional().describe('The agent type for spawned crewmates'),
    crew_name: z.string().optional().describe('The crew name'),
    description: z.string().optional().describe('A description of the crew'),
  }),
)

export type Input = z.infer<ReturnType<typeof inputSchema>>

export type SpawnCrewOutput = {
  operation: 'spawnCrew'
  success: boolean
  crewName?: string
  error?: string
}

export type CleanupOutput = {
  operation: 'cleanup'
  success: boolean
  error?: string
}

export type Output = SpawnCrewOutput | CleanupOutput
