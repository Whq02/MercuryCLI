import { readFile, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod/v4'

import { logForDebugging } from '../debug.js'
import { getCrewsDir } from '../envUtils.js'
import { errorMessage, isENOENT } from '../errors.js'
import { lazySchema } from '../lazySchema.js'

import { logError } from '../log.js'

import { getAgentId, getAgentName, getCrewName, getCrewmateColor } from '../crewmate.js'
import { sendLiveMessage } from '../../services/crew/liveComms.js'
import { createPermissionRequestMessage } from '../../services/crew/liveMessages.js'
import { CREW_LEAD_NAME } from './constants.js'
import { readCrewFileAsync, sanitizeName } from './crewHelpers.js'


export const CrewPermissionRequestSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    workerId: z.string(),
    workerName: z.string(),
    workerColor: z.string().optional(),
    crewName: z.string(),
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
    createdAt: z.number()
  }),
)

export type CrewPermissionRequest = z.infer<ReturnType<typeof CrewPermissionRequestSchema>>

type PermissionResponse = {
  requestId: string
  decision: 'approved' | 'denied'
  timestamp: string
  feedback?: string
  updatedInput?: Record<string, unknown>
  permissionUpdates?: unknown[]
}


function getPermissionDir(crewName: string): string {
  return join(getCrewsDir(), sanitizeName(crewName), 'permissions')
}

function getResolvedDir(crewName: string): string {
  return join(getPermissionDir(crewName), 'resolved')
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 9)
}

export function generateRequestId(): string {
  return `perm-${Date.now()}-${randomSuffix()}`
}

function resolveCrew(crewName: string | undefined): string | undefined {
  return crewName ?? getCrewName()
}


export function createPermissionRequest(params: {
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  description: string
  permissionSuggestions?: unknown[]
  workerId?: string
  workerName?: string
  workerColor?: string
  crewName?: string
}): CrewPermissionRequest {
  const crewName = params.crewName ?? getCrewName()
  if (!crewName) {
    throw new Error('Cannot create a permission request: no crew name could be determined')
  }
  const workerId = params.workerId ?? getAgentId()
  if (!workerId) {
    throw new Error('Cannot create a permission request: no worker id could be determined')
  }
  const workerName = params.workerName ?? getAgentName()
  if (!workerName) {
    throw new Error('Cannot create a permission request: no worker name could be determined')
  }
  const workerColor = params.workerColor ?? getCrewmateColor()
  return {
    id: generateRequestId(),
    workerId,
    workerName,
    ...(workerColor !== undefined ? { workerColor } : {}),
    crewName,
    toolName: params.toolName,
    toolUseId: params.toolUseId,
    description: params.description,
    input: params.input,
    permissionSuggestions: params.permissionSuggestions ?? [],
    status: 'pending',
    createdAt: Date.now()
  }
}

async function readResolvedPermission(
  requestId: string,
  crewName?: string,
): Promise<CrewPermissionRequest | null> {
  const crew = resolveCrew(crewName)
  if (!crew) return null
  try {
    const raw = await readFile(join(getResolvedDir(crew), `${requestId}.json`), 'utf-8')
    const parsed = CrewPermissionRequestSchema().safeParse(JSON.parse(raw))
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

async function deleteResolvedPermission(requestId: string, crewName?: string): Promise<boolean> {
  const crew = resolveCrew(crewName)
  if (!crew) return false
  try {
    await unlink(join(getResolvedDir(crew), `${requestId}.json`))
    return true
  } catch (error) {
    if (isENOENT(error)) return false
    logForDebugging(`permission sync: delete of ${requestId} failed: ${errorMessage(error)}`)
    return false
  }
}

export async function pollForResponse(
  requestId: string,
  _agentName?: string,
  crewName?: string,
): Promise<PermissionResponse | null> {
  const resolved = await readResolvedPermission(requestId, crewName)
  if (resolved === null || resolved.status === 'pending') return null
  return {
    requestId: resolved.id,
    decision: resolved.status === 'approved' ? 'approved' : 'denied',
    timestamp: new Date(resolved.resolvedAt ?? resolved.createdAt).toISOString(),
    ...(resolved.feedback !== undefined ? { feedback: resolved.feedback } : {}),
    ...(resolved.updatedInput !== undefined ? { updatedInput: resolved.updatedInput } : {}),
    ...(resolved.permissionUpdates !== undefined
      ? { permissionUpdates: resolved.permissionUpdates }
      : {})
  }
}

export async function removeWorkerResponse(
  requestId: string,
  _agentName?: string,
  crewName?: string,
): Promise<void> {
  await deleteResolvedPermission(requestId, crewName)
}


export function isCrewLeader(crewName?: string): boolean {
  const crew = resolveCrew(crewName)
  if (!crew) return false
  const agentId = getAgentId()
  return agentId === undefined || agentId === CREW_LEAD_NAME
}

export function isCrewmateWorker(): boolean {
  const crew = getCrewName()
  const agentId = getAgentId()
  return Boolean(crew) && agentId !== undefined && !isCrewLeader()
}

async function getLeaderName(crewName?: string): Promise<string | null> {
  const crew = resolveCrew(crewName)
  if (!crew) return null
  const roster = await readCrewFileAsync(crew)
  if (roster === null) {
    logForDebugging(`permission sync: no roster for ${crew} — cannot resolve the leader`)
    return null
  }
  return roster.members.find(member => member.agentId === roster.leadAgentId)?.name ?? CREW_LEAD_NAME
}


export async function sendPermissionRequestViaMailbox(
  request: CrewPermissionRequest,
): Promise<boolean> {
  try {
    const leaderName = await getLeaderName(request.crewName)
    if (leaderName === null) {
      logForDebugging(`permission sync: no leader for ${request.crewName} — request not sent`)
      return false
    }
    const message = createPermissionRequestMessage({
      request_id: request.id,
      agent_id: request.workerName,
      tool_name: request.toolName,
      tool_use_id: request.toolUseId,
      description: request.description,
      input: request.input,
      permission_suggestions: request.permissionSuggestions
    })
    return await sendLiveMessage(request.crewName, {
      to: leaderName,
      from: request.workerName,
      text: JSON.stringify(message),
      timestamp: new Date().toISOString(),
      ...(request.workerColor !== undefined ? { color: request.workerColor } : {})
    })
  } catch (error) {
    logError(error)
    return false
  }
}
