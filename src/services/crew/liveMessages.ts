import { z } from 'zod/v4'

import { CREWMATE_MESSAGE_TAG } from '../../constants/xml.js'
import type { Message } from '../../types/message.js'
import { PERMISSION_MODES, type InternalPermissionMode } from '../../types/permissions.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { CREW_LEAD_NAME } from '../../utils/crew/constants.js'
import { escapeXml, escapeXmlAttr } from '../../utils/xml.js'

export type LiveMessageEnvelope = {
  from: string
  text: string
  timestamp?: string
  color?: string
  summary?: string
}

export function formatCrewmateMessages(messages: readonly LiveMessageEnvelope[]): string {
  return messages
    .map(message => {
      const colorAttr = message.color !== undefined ? ` color="${escapeXmlAttr(message.color)}"` : ''
      const summaryAttr = message.summary !== undefined ? ` summary="${escapeXmlAttr(message.summary)}"` : ''
      return `<${CREWMATE_MESSAGE_TAG} crewmate_id="${escapeXmlAttr(message.from)}"${colorAttr}${summaryAttr}>\n${escapeXml(message.text)}\n</${CREWMATE_MESSAGE_TAG}>`
    })
    .join('\n\n')
}

function parseStructuredText(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

type IdleNotificationMessage = {
  type: 'idle_notification'
  from: string
  timestamp: string
  idleReason?: 'available' | 'interrupted' | 'failed'
  summary?: string
  completedTaskId?: string
  completedStatus?: 'resolved' | 'blocked' | 'failed'
  failureReason?: string
}

export function createIdleNotification(
  from: string,
  options?: Omit<IdleNotificationMessage, 'type' | 'from' | 'timestamp'>,
): IdleNotificationMessage {
  return { type: 'idle_notification', from, timestamp: new Date().toISOString(), ...options }
}

export function isIdleNotification(text: string): IdleNotificationMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'idle_notification') return null
  return parsed as IdleNotificationMessage
}

type PermissionRequestMessage = {
  type: 'permission_request'
  request_id: string
  agent_id: string
  tool_name: string
  tool_use_id: string
  description: string
  input: Record<string, unknown>
  permission_suggestions: unknown[]
}

export function createPermissionRequestMessage(params: {
  request_id: string
  agent_id: string
  tool_name: string
  tool_use_id: string
  description: string
  input: Record<string, unknown>
  permission_suggestions?: unknown[]
}): PermissionRequestMessage {
  return { type: 'permission_request', permission_suggestions: [], ...params }
}

export function isPermissionRequest(text: string): PermissionRequestMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'permission_request') return null
  return parsed as PermissionRequestMessage
}

type PermissionResponseMessage = {
  type: 'permission_response'
  request_id: string
} & (
  | {
      subtype: 'success'
      response?: { updated_input?: Record<string, unknown>; permission_updates?: unknown[] }
    }
  | { subtype: 'error'; error: string }
)

export function createPermissionResponseMessage(params: {
  request_id: string
  subtype: 'success' | 'error'
  error?: string | undefined
  updated_input?: Record<string, unknown> | undefined
  permission_updates?: unknown[] | undefined
}): PermissionResponseMessage {
  if (params.subtype === 'success') {
    const response = {
      ...(params.updated_input !== undefined ? { updated_input: params.updated_input } : {}),
      ...(params.permission_updates !== undefined ? { permission_updates: params.permission_updates } : {}),
    }
    return {
      type: 'permission_response',
      request_id: params.request_id,
      subtype: 'success',
      ...(Object.keys(response).length > 0 ? { response } : {}),
    }
  }
  return {
    type: 'permission_response',
    request_id: params.request_id,
    subtype: 'error',
    error: params.error ?? 'Permission denied',
  }
}

export function isPermissionResponse(text: string): PermissionResponseMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'permission_response') return null
  return parsed as PermissionResponseMessage
}

const ShutdownRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_request'),
    requestId: z.string(),
    from: z.string(),
    reason: z.string().optional(),
    timestamp: z.string(),
  }),
)
export type ShutdownRequestMessage = z.infer<ReturnType<typeof ShutdownRequestMessageSchema>>

export function createShutdownRequestMessage(params: {
  requestId: string
  from: string
  reason?: string
}): ShutdownRequestMessage {
  return {
    type: 'shutdown_request',
    requestId: params.requestId,
    from: params.from,
    ...(params.reason !== undefined ? { reason: params.reason } : {}),
    timestamp: new Date().toISOString(),
  }
}

export function isShutdownRequest(text: string): ShutdownRequestMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'shutdown_request') return null
  const result = ShutdownRequestMessageSchema().safeParse(parsed)
  return result.success ? result.data : null
}

const ShutdownApprovedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_approved'),
    requestId: z.string(),
    from: z.string(),
    timestamp: z.string(),
    paneId: z.string().optional(),
    backendType: z.string().optional(),
  }),
)
type ShutdownApprovedMessage = z.infer<ReturnType<typeof ShutdownApprovedMessageSchema>>

export function createShutdownApprovedMessage(params: {
  requestId: string
  from: string
  paneId?: string | undefined
  backendType?: string | undefined
}): ShutdownApprovedMessage {
  return {
    type: 'shutdown_approved',
    requestId: params.requestId,
    from: params.from,
    timestamp: new Date().toISOString(),
    ...(params.paneId !== undefined ? { paneId: params.paneId } : {}),
    ...(params.backendType !== undefined ? { backendType: params.backendType } : {}),
  }
}

export function isShutdownApproved(text: string): ShutdownApprovedMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'shutdown_approved') return null
  const result = ShutdownApprovedMessageSchema().safeParse(parsed)
  return result.success ? result.data : null
}

const ShutdownRejectedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_rejected'),
    requestId: z.string(),
    from: z.string(),
    reason: z.string(),
    timestamp: z.string(),
  }),
)
export type ShutdownRejectedMessage = z.infer<ReturnType<typeof ShutdownRejectedMessageSchema>>

export function createShutdownRejectedMessage(params: {
  requestId: string
  from: string
  reason: string
}): ShutdownRejectedMessage {
  return {
    type: 'shutdown_rejected',
    requestId: params.requestId,
    from: params.from,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  }
}

export function isShutdownRejected(text: string): ShutdownRejectedMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'shutdown_rejected') return null
  const result = ShutdownRejectedMessageSchema().safeParse(parsed)
  return result.success ? result.data : null
}

export type TaskAssignmentMessage = {
  type: 'task_assignment'
  taskId: string
  subject: string
  description: string
  assignedBy: string
  timestamp: string
}

export function isTaskAssignment(text: string): TaskAssignmentMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'task_assignment') return null
  return parsed as TaskAssignmentMessage
}

export type CrewPermissionUpdateMessage = {
  type: 'crew_permission_update'
  permissionUpdate: {
    type: 'addRules'
    rules: Array<{ toolName: string; ruleContent?: string }>
    behavior: 'allow' | 'deny' | 'ask'
    destination: 'session'
  }
  directoryPath: string
  toolName: string
}

export function isCrewPermissionUpdate(text: string): CrewPermissionUpdateMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'crew_permission_update') return null
  return parsed as CrewPermissionUpdateMessage
}

const ModeSetRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('mode_set_request'),
    mode: z.custom<InternalPermissionMode>(
      value => typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value),
    ),
    from: z.string(),
  }),
)
type ModeSetRequestMessage = z.infer<ReturnType<typeof ModeSetRequestMessageSchema>>

export function isModeSetRequest(text: string): ModeSetRequestMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'mode_set_request') return null
  const result = ModeSetRequestMessageSchema().safeParse(parsed)
  return result.success ? result.data : null
}

const STRUCTURED_PROTOCOL_TYPES: ReadonlySet<string> = new Set([
  'permission_request',
  'permission_response',
  'sandbox_permission_request',
  'sandbox_permission_response',
  'shutdown_request',
  'shutdown_approved',
  'crew_permission_update',
  'mode_set_request',
])

export function isStructuredProtocolMessage(messageText: string): boolean {
  const parsed = parseStructuredText(messageText)
  if (!parsed || typeof parsed.type !== 'string') return false
  return STRUCTURED_PROTOCOL_TYPES.has(parsed.type)
}

export function resolveShutdownApprovedVictim(
  envelopeFrom: string | undefined,
  parsed: ShutdownApprovedMessage | null | undefined,
): string | null {
  const envelope = envelopeFrom?.trim() ?? ''
  if (envelope === '') return null
  const inBody = typeof parsed?.from === 'string' ? parsed.from.trim() : ''
  if (inBody !== '' && inBody !== envelope) return null
  return envelope
}

export function resolveShutdownRequestSender(
  envelopeFrom: string | undefined,
  parsed: ShutdownRequestMessage | null,
): string | null {
  if (!parsed) return null
  const envelope = envelopeFrom?.trim() ?? ''
  if (envelope === '') return null
  const inBody = typeof parsed.from === 'string' ? parsed.from.trim() : ''
  if (inBody !== '' && inBody !== envelope) return null
  return envelope
}

const DM_GIST_LENGTH = 80
const BROADCAST_TARGET = '*'

export function getLastPeerDmSummary(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) continue
    if (message.type === 'user' && typeof message.message.content === 'string') return undefined
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{
      type?: string
      name?: string
      input?: { to?: unknown; message?: unknown; summary?: unknown }
    }>) {
      if (block.type !== 'tool_use' || block.name !== 'SendMessage') continue
      const to = block.input?.to
      if (typeof to !== 'string') continue
      if (to === BROADCAST_TARGET) continue
      if (to.toLowerCase() === CREW_LEAD_NAME.toLowerCase()) continue
      const body = block.input?.message
      if (typeof body !== 'string') continue
      const summary = block.input?.summary
      const gist = typeof summary === 'string' ? summary : body.slice(0, DM_GIST_LENGTH)
      return `[DM to ${to}] ${gist}`
    }
  }
  return undefined
}
