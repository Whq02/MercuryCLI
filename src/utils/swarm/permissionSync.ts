import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod/v4'

import { logForDebugging } from '../debug.js'
import { getTeamsDir } from '../envUtils.js'
import { errorMessage, isENOENT } from '../errors.js'
import { lazySchema } from '../lazySchema.js'
import * as lockfile from '../lockfile.js'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'
import { getAgentId, getAgentName, getTeamName, getTeammateColor } from '../teammate.js'
import {
  createPermissionRequestMessage,
  createPermissionResponseMessage,
  createSandboxPermissionRequestMessage,
  createSandboxPermissionResponseMessage,
  writeToMailbox,
} from '../teammateMailbox.js'
import { TEAM_LEAD_NAME } from './constants.js'
import { readTeamFileAsync, sanitizeName } from './teamHelpers.js'

/**
 * Cross-agent permission request/response. Two transports coexist and BOTH
 * are used (risk R4): the on-disk pending/resolved store backs the legacy
 * worker poll, and the mailbox path is the current transport.
 *
 * On-disk layout (contract data — other Mercury processes read it):
 *
 *     <teams-dir>/<sanitized-team>/permissions/pending/<requestId>.json
 *     <teams-dir>/<sanitized-team>/permissions/resolved/<requestId>.json
 *     <teams-dir>/<sanitized-team>/permissions/pending/.lock
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Lazily built; records are validated against it on every read. */
export const SwarmPermissionRequestSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    workerId: z.string(),
    workerName: z.string(),
    workerColor: z.string().optional(),
    teamName: z.string(),
    toolName: z.string(),
    toolUseId: z.string(),
    description: z.string(),
    input: z.record(z.string(), z.unknown()),
    permissionSuggestions: z.array(z.unknown()),
    status: z.enum(['pending', 'approved', 'rejected']),
    resolvedBy: z.enum(['worker', 'leader']).optional(),
    resolvedAt: z.number().optional(),
    feedback: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    permissionUpdates: z.array(z.unknown()).optional(),
    createdAt: z.number(),
  }),
)

export type SwarmPermissionRequest = z.infer<ReturnType<typeof SwarmPermissionRequestSchema>>

export type PermissionResolution = {
  decision: 'approved' | 'rejected'
  resolvedBy: 'worker' | 'leader'
  feedback?: string
  updatedInput?: Record<string, unknown>
  permissionUpdates?: unknown[]
}

/** The legacy poll shape. */
export type PermissionResponse = {
  requestId: string
  decision: 'approved' | 'denied'
  timestamp: string
  feedback?: string
  updatedInput?: Record<string, unknown>
  permissionUpdates?: unknown[]
}

// ---------------------------------------------------------------------------
// Paths, ids, team resolution
// ---------------------------------------------------------------------------

export function getPermissionDir(teamName: string): string {
  return join(getTeamsDir(), sanitizeName(teamName), 'permissions')
}

function getPendingDir(teamName: string): string {
  return join(getPermissionDir(teamName), 'pending')
}

function getResolvedDir(teamName: string): string {
  return join(getPermissionDir(teamName), 'resolved')
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 9)
}

export function generateRequestId(): string {
  return `perm-${Date.now()}-${randomSuffix()}`
}

export function generateSandboxRequestId(): string {
  return `sandbox-${Date.now()}-${randomSuffix()}`
}

/** Every team-scoped entry point falls back to the ambient teammate identity. */
function resolveTeam(teamName: string | undefined): string | undefined {
  return teamName ?? getTeamName()
}

// ---------------------------------------------------------------------------
// The on-disk store
// ---------------------------------------------------------------------------

export function createPermissionRequest(params: {
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  description: string
  permissionSuggestions?: unknown[]
  workerId?: string
  workerName?: string
  workerColor?: string
  teamName?: string
}): SwarmPermissionRequest {
  const teamName = params.teamName ?? getTeamName()
  if (!teamName) {
    throw new Error('Cannot create a permission request: no team name could be determined')
  }
  const workerId = params.workerId ?? getAgentId()
  if (!workerId) {
    throw new Error('Cannot create a permission request: no worker id could be determined')
  }
  const workerName = params.workerName ?? getAgentName()
  if (!workerName) {
    throw new Error('Cannot create a permission request: no worker name could be determined')
  }
  const workerColor = params.workerColor ?? getTeammateColor()
  return {
    id: generateRequestId(),
    workerId,
    workerName,
    ...(workerColor !== undefined ? { workerColor } : {}),
    teamName,
    toolName: params.toolName,
    toolUseId: params.toolUseId,
    description: params.description,
    input: params.input,
    permissionSuggestions: params.permissionSuggestions ?? [],
    status: 'pending',
    createdAt: Date.now(),
  }
}

async function ensurePermissionDirs(teamName: string): Promise<void> {
  await mkdir(getPendingDir(teamName), { recursive: true })
  await mkdir(getResolvedDir(teamName), { recursive: true })
}

/** Write (creating or truncating) the lock file, take an exclusive lock, always release. */
async function withPendingLock<R>(teamName: string, fn: () => Promise<R>): Promise<R> {
  const lockPath = join(getPendingDir(teamName), '.lock')
  await writeFile(lockPath, '')
  const release = await lockfile.lock(lockPath)
  try {
    return await fn()
  } finally {
    await release()
  }
}

export async function writePermissionRequest(
  request: SwarmPermissionRequest,
): Promise<SwarmPermissionRequest> {
  try {
    await ensurePermissionDirs(request.teamName)
    await withPendingLock(request.teamName, async () => {
      await writeFile(
        join(getPendingDir(request.teamName), `${request.id}.json`),
        jsonStringify(request, null, 2),
      )
    })
    return request
  } catch (error) {
    logError(error)
    throw error
  }
}

/** Alias kept for callers using the submission name. */
export const submitPermissionRequest = writePermissionRequest

export async function readPendingPermissions(teamName?: string): Promise<SwarmPermissionRequest[]> {
  const team = resolveTeam(teamName)
  if (!team) {
    logForDebugging('permission sync: no team — pending read answers empty')
    return []
  }
  let entries: string[]
  try {
    entries = await readdir(getPendingDir(team))
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`permission sync: pending read failed: ${errorMessage(error)}`)
    }
    return []
  }
  const requests: SwarmPermissionRequest[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry === '.lock') continue
    try {
      const raw = await readFile(join(getPendingDir(team), entry), 'utf-8')
      const parsed = SwarmPermissionRequestSchema().safeParse(JSON.parse(raw))
      if (!parsed.success) {
        logForDebugging(`permission sync: dropping invalid pending record ${entry}`)
        continue
      }
      requests.push(parsed.data)
    } catch (error) {
      logForDebugging(`permission sync: dropping unreadable pending record ${entry}: ${errorMessage(error)}`)
    }
  }
  return requests.sort((a, b) => a.createdAt - b.createdAt)
}

export async function readResolvedPermission(
  requestId: string,
  teamName?: string,
): Promise<SwarmPermissionRequest | null> {
  const team = resolveTeam(teamName)
  if (!team) return null
  try {
    const raw = await readFile(join(getResolvedDir(team), `${requestId}.json`), 'utf-8')
    const parsed = SwarmPermissionRequestSchema().safeParse(JSON.parse(raw))
    if (!parsed.success) {
      logForDebugging(`permission sync: resolved record ${requestId} is invalid`)
      return null
    }
    return parsed.data
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`permission sync: resolved read for ${requestId} failed: ${errorMessage(error)}`)
    }
    return null
  }
}

export async function resolvePermission(
  requestId: string,
  resolution: PermissionResolution,
  teamName?: string,
): Promise<boolean> {
  const team = resolveTeam(teamName)
  if (!team) return false
  try {
    await ensurePermissionDirs(team)
    return await withPendingLock(team, async () => {
      const pendingPath = join(getPendingDir(team), `${requestId}.json`)
      let pending: SwarmPermissionRequest
      try {
        const parsed = SwarmPermissionRequestSchema().safeParse(
          JSON.parse(await readFile(pendingPath, 'utf-8')),
        )
        if (!parsed.success) return false
        pending = parsed.data
      } catch {
        return false
      }
      const resolved: SwarmPermissionRequest = {
        ...pending,
        status: resolution.decision,
        resolvedBy: resolution.resolvedBy,
        resolvedAt: Date.now(),
        ...(resolution.feedback !== undefined ? { feedback: resolution.feedback } : {}),
        ...(resolution.updatedInput !== undefined ? { updatedInput: resolution.updatedInput } : {}),
        ...(resolution.permissionUpdates !== undefined
          ? { permissionUpdates: resolution.permissionUpdates }
          : {}),
      }
      await writeFile(join(getResolvedDir(team), `${requestId}.json`), jsonStringify(resolved, null, 2))
      await unlink(pendingPath)
      return true
    })
  } catch (error) {
    logForDebugging(`permission sync: resolve of ${requestId} failed: ${errorMessage(error)}`)
    return false
  }
}

export async function deleteResolvedPermission(requestId: string, teamName?: string): Promise<boolean> {
  const team = resolveTeam(teamName)
  if (!team) return false
  try {
    await unlink(join(getResolvedDir(team), `${requestId}.json`))
    return true
  } catch (error) {
    if (isENOENT(error)) return false
    logForDebugging(`permission sync: delete of ${requestId} failed: ${errorMessage(error)}`)
    return false
  }
}

/**
 * Delete resolved records at least `maxAgeMs` old (so a max age of 0 clears
 * everything), measured from the resolution time or, absent that, the
 * creation time. Unparsable files are deleted too (and counted); a delete
 * that itself fails is not counted.
 */
export async function cleanupOldResolutions(teamName?: string, maxAgeMs = 3_600_000): Promise<number> {
  const team = resolveTeam(teamName)
  if (!team) return 0
  let entries: string[]
  try {
    entries = await readdir(getResolvedDir(team))
  } catch {
    return 0
  }
  const now = Date.now()
  let deleted = 0
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const path = join(getResolvedDir(team), entry)
    let shouldDelete = false
    try {
      const parsed = SwarmPermissionRequestSchema().safeParse(JSON.parse(await readFile(path, 'utf-8')))
      if (!parsed.success) {
        shouldDelete = true
      } else {
        const age = now - (parsed.data.resolvedAt ?? parsed.data.createdAt)
        shouldDelete = age >= maxAgeMs
      }
    } catch {
      shouldDelete = true
    }
    if (!shouldDelete) continue
    try {
      await unlink(path)
      deleted += 1
    } catch {
      // A failed delete is not counted.
    }
  }
  return deleted
}

/** The legacy poll shape; the agent-name argument is accepted but unused. */
export async function pollForResponse(
  requestId: string,
  _agentName?: string,
  teamName?: string,
): Promise<PermissionResponse | null> {
  const resolved = await readResolvedPermission(requestId, teamName)
  if (resolved === null || resolved.status === 'pending') return null
  return {
    requestId: resolved.id,
    decision: resolved.status === 'approved' ? 'approved' : 'denied',
    timestamp: new Date(resolved.resolvedAt ?? resolved.createdAt).toISOString(),
    ...(resolved.feedback !== undefined ? { feedback: resolved.feedback } : {}),
    ...(resolved.updatedInput !== undefined ? { updatedInput: resolved.updatedInput } : {}),
    ...(resolved.permissionUpdates !== undefined
      ? { permissionUpdates: resolved.permissionUpdates }
      : {}),
  }
}

/** A thin alias over the resolved delete. */
export async function removeWorkerResponse(
  requestId: string,
  _agentName?: string,
  teamName?: string,
): Promise<void> {
  await deleteResolvedPermission(requestId, teamName)
}

// ---------------------------------------------------------------------------
// Role tests and the leader lookup
// ---------------------------------------------------------------------------

/** Leader: a team is known and either no agent id is set or it equals the team-lead name. */
export function isTeamLeader(teamName?: string): boolean {
  const team = resolveTeam(teamName)
  if (!team) return false
  const agentId = getAgentId()
  return agentId === undefined || agentId === TEAM_LEAD_NAME
}

/** Swarm worker: both a team and an agent id exist and it is not the leader. */
export function isSwarmWorker(): boolean {
  const team = getTeamName()
  const agentId = getAgentId()
  return Boolean(team) && agentId !== undefined && !isTeamLeader()
}

/**
 * The lead's display name: the roster member whose agent id equals the
 * roster's lead agent id, falling back to the team-lead name; null when no
 * team is known, and null with a log when the roster is missing.
 */
export async function getLeaderName(teamName?: string): Promise<string | null> {
  const team = resolveTeam(teamName)
  if (!team) return null
  const roster = await readTeamFileAsync(team)
  if (roster === null) {
    logForDebugging(`permission sync: no roster for ${team} — cannot resolve the leader`)
    return null
  }
  return roster.members.find(member => member.agentId === roster.leadAgentId)?.name ?? TEAM_LEAD_NAME
}

// ---------------------------------------------------------------------------
// The mailbox transport
// ---------------------------------------------------------------------------

/** The worker's NAME travels as the agent id on the wire (contract data). */
export async function sendPermissionRequestViaMailbox(
  request: SwarmPermissionRequest,
): Promise<boolean> {
  try {
    const leaderName = await getLeaderName(request.teamName)
    if (leaderName === null) {
      logForDebugging(`permission sync: no leader for ${request.teamName} — request not sent`)
      return false
    }
    const message = createPermissionRequestMessage({
      request_id: request.id,
      agent_id: request.workerName,
      tool_name: request.toolName,
      tool_use_id: request.toolUseId,
      description: request.description,
      input: request.input,
      permission_suggestions: request.permissionSuggestions,
    })
    return await writeToMailbox(
      leaderName,
      {
        from: request.workerName,
        text: JSON.stringify(message),
        timestamp: new Date().toISOString(),
        ...(request.workerColor !== undefined ? { color: request.workerColor } : {}),
      },
      request.teamName,
    )
  } catch (error) {
    logError(error)
    return false
  }
}

export async function sendPermissionResponseViaMailbox(
  workerName: string,
  resolution: PermissionResolution,
  requestId: string,
  teamName?: string,
): Promise<boolean> {
  try {
    const team = resolveTeam(teamName)
    if (!team) {
      logForDebugging('permission sync: no team — permission response not sent')
      return false
    }
    const message = createPermissionResponseMessage({
      request_id: requestId,
      subtype: resolution.decision === 'approved' ? 'success' : 'error',
      ...(resolution.feedback !== undefined ? { error: resolution.feedback } : {}),
      ...(resolution.updatedInput !== undefined ? { updated_input: resolution.updatedInput } : {}),
      ...(resolution.permissionUpdates !== undefined
        ? { permission_updates: resolution.permissionUpdates }
        : {}),
    })
    return await writeToMailbox(
      workerName,
      {
        from: getAgentName() ?? TEAM_LEAD_NAME,
        text: JSON.stringify(message),
        timestamp: new Date().toISOString(),
      },
      team,
    )
  } catch (error) {
    logError(error)
    return false
  }
}

export async function sendSandboxPermissionRequestViaMailbox(
  host: string,
  requestId: string,
  teamName?: string,
): Promise<boolean> {
  try {
    const team = resolveTeam(teamName)
    if (!team) {
      logForDebugging('permission sync: no team — sandbox request not sent')
      return false
    }
    const leaderName = await getLeaderName(team)
    if (leaderName === null) {
      logForDebugging(`permission sync: no leader for ${team} — sandbox request not sent`)
      return false
    }
    const workerId = getAgentId()
    if (!workerId) {
      logForDebugging('permission sync: no worker id — sandbox request not sent')
      return false
    }
    const workerName = getAgentName()
    if (!workerName) {
      logForDebugging('permission sync: no worker name — sandbox request not sent')
      return false
    }
    const workerColor = getTeammateColor()
    const message = createSandboxPermissionRequestMessage({
      requestId,
      workerId,
      workerName,
      ...(workerColor !== undefined ? { workerColor } : {}),
      host,
    })
    return await writeToMailbox(
      leaderName,
      {
        from: workerName,
        text: JSON.stringify(message),
        timestamp: new Date().toISOString(),
        ...(workerColor !== undefined ? { color: workerColor } : {}),
      },
      team,
    )
  } catch (error) {
    logError(error)
    return false
  }
}

export async function sendSandboxPermissionResponseViaMailbox(
  workerName: string,
  requestId: string,
  host: string,
  allow: boolean,
  teamName?: string,
): Promise<boolean> {
  try {
    const team = resolveTeam(teamName)
    if (!team) {
      logForDebugging('permission sync: no team — sandbox response not sent')
      return false
    }
    const message = createSandboxPermissionResponseMessage({ requestId, host, allow })
    return await writeToMailbox(
      workerName,
      {
        from: getAgentName() ?? TEAM_LEAD_NAME,
        text: JSON.stringify(message),
        timestamp: new Date().toISOString(),
      },
      team,
    )
  } catch (error) {
    logError(error)
    return false
  }
}
