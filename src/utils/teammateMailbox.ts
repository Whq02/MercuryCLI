import { existsSync } from 'node:fs'
import { randomUUID, type UUID } from 'node:crypto'
import { join } from 'node:path'

import { z } from 'zod/v4'

import { TEAMMATE_MESSAGE_TAG } from '../constants/xml.js'
import { PermissionModeSchema } from '../entrypoints/sdk/coreSchemas.js'
import { defineStore } from '../substrate/fileStore.js'
import type { Message } from '../types/message.js'
import { PERMISSION_MODES, type InternalPermissionMode } from '../types/permissions.js'
import { generateRequestId } from './agentId.js'
import { logForDebugging } from './debug.js'
import { getTeamsDir } from './envUtils.js'
import { lazySchema } from './lazySchema.js'
import { logError } from './log.js'
import { TEAM_LEAD_NAME } from './swarm/constants.js'
import { sanitizePathComponent } from './tasks.js'
import { getAgentName, getTeammateColor, getTeamName } from './teammate.js'
import { escapeXml, escapeXmlAttr } from './xml.js'


export type TeammateMessage = {
  from: string
  text: string
  timestamp: string
  read?: boolean
  color?: string
  summary?: string
  id?: string
  seq?: number
  delivery?: { id: string; sessionId: string }
}

function isValidMessage(candidate: unknown): candidate is TeammateMessage {
  if (typeof candidate !== 'object' || candidate === null) return false
  const record = candidate as Record<string, unknown>
  return (
    typeof record.from === 'string' &&
    typeof record.text === 'string' &&
    typeof record.timestamp === 'string'
  )
}

function resolveTeamName(teamName: string | undefined): string {
  return teamName ?? getTeamName() ?? 'default'
}

export function getInboxPath(agentName: string, teamName?: string): string {
  const team = resolveTeamName(teamName)
  const path = join(getTeamsDir(), sanitizePathComponent(team), 'inboxes', `${sanitizePathComponent(agentName)}.json`)
  logForDebugging(`mailbox: inbox for ${agentName} in team ${team} at ${path}`)
  return path
}

const mailboxStore = defineStore<TeammateMessage[], [string, (string | undefined)?]>({
  name: 'teammate-mailbox',
  path: (agentName: string, teamName?: string) => getInboxPath(agentName, teamName),
  schemaVersion: 1,
  decode: raw => {
    if (!Array.isArray(raw)) return null
    return raw.filter(isValidMessage).map(message => {
      const delivery = message.delivery
      if (delivery === undefined) return message
      const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
      if (delivery !== null && typeof delivery.id === 'string' && typeof delivery.sessionId === 'string' && uuid.test(delivery.id) && uuid.test(delivery.sessionId)) return message
      const { delivery: invalid, ...content } = message
      return content
    })
  },
  empty: () => [],
  onReadFailure: 'empty',
  pollFloorMs: 1000,
  revisionOf: messages => messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0),
})

export function getMailboxStore(agentName: string, teamName?: string): ReturnType<typeof mailboxStore> {
  return mailboxStore(agentName, teamName)
}

const COMPACTION_TRIGGER = 200
const COMPACTION_READ_KEEP = 100

function compactInbox(messages: TeammateMessage[]): TeammateMessage[] {
  if (messages.length <= COMPACTION_TRIGGER) return messages
  const readCount = messages.reduce((count, message) => count + (message.read ? 1 : 0), 0)
  let excess = readCount - COMPACTION_READ_KEEP
  if (excess <= 0) return messages
  const kept: TeammateMessage[] = []
  for (const message of messages) {
    if (excess > 0 && message.read) {
      excess--
      continue
    }
    kept.push(message)
  }
  return kept
}

export async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName?: string,
): Promise<boolean> {
  try {
    await getMailboxStore(recipientName, teamName).mutate(current => {
      const maxSeq = current.reduce((max, existing) => Math.max(max, existing.seq ?? 0), 0)
      const stamped: TeammateMessage = {
        ...message,
        read: false,
        id: message.id ?? generateRequestId('msg', recipientName),
        seq: maxSeq + 1,
      }
      return compactInbox([...current, stamped])
    })
    logForDebugging(`mailbox: delivered to ${recipientName} from ${message.from}`)
    return true
  } catch (error) {
    logForDebugging(`mailbox: write to ${recipientName} failed: ${String(error)}`)
    logError(error)
    return false
  }
}

export async function readMailbox(agentName: string, teamName?: string): Promise<TeammateMessage[]> {
  return getMailboxStore(agentName, teamName).read()
}

export async function readUnreadMessages(agentName: string, teamName?: string): Promise<TeammateMessage[]> {
  const all = await getMailboxStore(agentName, teamName).read()
  const unread = all.filter(message => !message.read)
  logForDebugging(`mailbox: ${agentName} has ${unread.length} unread of ${all.length}`)
  return unread
}

export interface MailboxDelivery {
  id: string
  sessionId: string
  recovered: boolean
  messages: TeammateMessage[]
}

export async function prepareMailboxDelivery(
  agentName: string,
  teamName: string,
  sessionId: string,
): Promise<MailboxDelivery | null> {
  const store = getMailboxStore(agentName, teamName)
  if (!(await store.read()).some(message => !message.read)) return null
  return store.update<MailboxDelivery | null>(current => {
    const unread = current.filter(message => !message.read)
    if (unread.length === 0) return { next: current, result: null }
    const pending = unread.find(message => message.delivery !== undefined)?.delivery
    if (pending !== undefined) {
      return { next: current, result: { ...pending, recovered: true, messages: unread.filter(message => message.delivery?.id === pending.id) } }
    }
    const delivery = { id: randomUUID(), sessionId }
    const next = current.map(message => message.read ? message : { ...message, delivery })
    return { next, result: { ...delivery, recovered: false, messages: next.filter(message => !message.read) } }
  })
}

export async function wasMailboxDeliveryHandled(delivery: MailboxDelivery, messages: readonly Message[]): Promise<boolean> {
  if (!delivery.recovered) return false
  const { isSessionCleared } = await import('./sessionStorage/clearedSessions.js')
  if (isSessionCleared(delivery.sessionId)) return true
  const carriesId = (message: Message): boolean => message.uuid === delivery.id ||
    (message.type === 'user' && message.batchUuids?.includes(delivery.id) === true)
  if (messages.some(carriesId)) return true
  const { loadSessionFile } = await import('./sessionStorage/loading.js')
  const stored = await loadSessionFile(delivery.sessionId as UUID)
  return [...stored.messages.values()].some(carriesId)
}

export async function acknowledgeMailboxDelivery(agentName: string, teamName: string, id: string): Promise<void> {
  await getMailboxStore(agentName, teamName).mutate(current => {
    if (!current.some(message => !message.read && message.delivery?.id === id)) return current
    return current.map(message => !message.read && message.delivery?.id === id ? { ...message, read: true } : message)
  })
}

export async function markMessagesAsRead(agentName: string, teamName?: string): Promise<void> {
  try {
    await getMailboxStore(agentName, teamName).mutate(current => {
      if (current.length === 0 || current.every(message => message.read)) return current
      return current.map(message => (message.read ? message : { ...message, read: true }))
    })
  } catch (error) {
    logForDebugging(`mailbox: mark-all-read failed for ${agentName}: ${String(error)}`)
    logError(error)
  }
}

export async function markMessagesFromAsRead(agentName: string, from: string, teamName?: string): Promise<void> {
  try {
    await getMailboxStore(agentName, teamName).mutate(current => {
      if (!current.some(message => !message.read && message.from === from)) return current
      return current.map(message =>
        !message.read && message.from === from ? { ...message, read: true } : message,
      )
    })
  } catch (error) {
    logForDebugging(`mailbox: mark-from-read failed for ${agentName}: ${String(error)}`)
    logError(error)
  }
}

export async function markSpecificMessageAsRead(
  agentName: string,
  teamName: string | undefined,
  msg: { from: string; text: string; timestamp: string; id?: string },
): Promise<void> {
  await getMailboxStore(agentName, teamName).mutate(current => {
    const index = current.findIndex(candidate => {
      if (candidate.read) return false
      if (candidate.id !== undefined && msg.id !== undefined) return candidate.id === msg.id
      return (
        candidate.from === msg.from && candidate.text === msg.text && candidate.timestamp === msg.timestamp
      )
    })
    if (index === -1) return current
    return current.map((candidate, i) => (i === index ? { ...candidate, read: true } : candidate))
  })
}

export async function markMessagesAsReadByPredicate(
  agentName: string,
  predicate: (message: TeammateMessage) => boolean,
  teamName?: string,
): Promise<void> {
  try {
    await getMailboxStore(agentName, teamName).mutate(current => {
      if (!current.some(message => !message.read && predicate(message))) return current
      return current.map(message =>
        !message.read && predicate(message) ? { ...message, read: true } : message,
      )
    })
  } catch (error) {
    logForDebugging(`mailbox: predicate mark-read failed for ${agentName}: ${String(error)}`)
    logError(error)
  }
}

export async function clearMailbox(agentName: string, teamName?: string): Promise<void> {
  try {
    const store = getMailboxStore(agentName, teamName)
    if (!existsSync(store.path)) return
    await store.write([])
    logForDebugging(`mailbox: cleared inbox for ${agentName}`)
  } catch (error) {
    logForDebugging(`mailbox: clear failed for ${agentName}: ${String(error)}`)
    logError(error)
  }
}

export function formatTeammateMessages(messages: TeammateMessage[]): string {
  return messages
    .map(message => {
      const colorAttr = message.color !== undefined ? ` color="${escapeXmlAttr(message.color)}"` : ''
      const summaryAttr = message.summary !== undefined ? ` summary="${escapeXmlAttr(message.summary)}"` : ''
      return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${escapeXmlAttr(message.from)}"${colorAttr}${summaryAttr}>\n${escapeXml(message.text)}\n</${TEAMMATE_MESSAGE_TAG}>`
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

export type IdleNotificationMessage = {
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

export type PermissionRequestMessage = {
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

export type PermissionResponseMessage = {
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

export type SandboxPermissionRequestMessage = {
  type: 'sandbox_permission_request'
  requestId: string
  workerId: string
  workerName: string
  workerColor?: string
  hostPattern: { host: string }
  createdAt: number
}

export function createSandboxPermissionRequestMessage(params: {
  requestId: string
  workerId: string
  workerName: string
  workerColor?: string
  host: string
}): SandboxPermissionRequestMessage {
  return {
    type: 'sandbox_permission_request',
    requestId: params.requestId,
    workerId: params.workerId,
    workerName: params.workerName,
    ...(params.workerColor !== undefined ? { workerColor: params.workerColor } : {}),
    hostPattern: { host: params.host },
    createdAt: Date.now(),
  }
}

export function isSandboxPermissionRequest(text: string): SandboxPermissionRequestMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'sandbox_permission_request') return null
  return parsed as SandboxPermissionRequestMessage
}

export type SandboxPermissionResponseMessage = {
  type: 'sandbox_permission_response'
  requestId: string
  host: string
  allow: boolean
  timestamp: string
}

export function createSandboxPermissionResponseMessage(params: {
  requestId: string
  host: string
  allow: boolean
}): SandboxPermissionResponseMessage {
  return {
    type: 'sandbox_permission_response',
    requestId: params.requestId,
    host: params.host,
    allow: params.allow,
    timestamp: new Date().toISOString(),
  }
}

export function isSandboxPermissionResponse(text: string): SandboxPermissionResponseMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'sandbox_permission_response') return null
  return parsed as SandboxPermissionResponseMessage
}

export const PlanApprovalRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('plan_approval_request'),
    from: z.string(),
    timestamp: z.string(),
    planFilePath: z.string(),
    planContent: z.string(),
    requestId: z.string(),
  }),
)
export type PlanApprovalRequestMessage = z.infer<ReturnType<typeof PlanApprovalRequestMessageSchema>>

export function isPlanApprovalRequest(text: string): PlanApprovalRequestMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'plan_approval_request') return null
  const result = PlanApprovalRequestMessageSchema().safeParse(parsed)
  return result.success ? result.data : null
}

export const PlanApprovalResponseMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('plan_approval_response'),
    requestId: z.string(),
    approved: z.boolean(),
    feedback: z.string().optional(),
    timestamp: z.string(),
    permissionMode: PermissionModeSchema().optional(),
  }),
)
export type PlanApprovalResponseMessage = z.infer<ReturnType<typeof PlanApprovalResponseMessageSchema>>

export function isPlanApprovalResponse(text: string): PlanApprovalResponseMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'plan_approval_response') return null
  const result = PlanApprovalResponseMessageSchema().safeParse(parsed)
  return result.success ? result.data : null
}

export const ShutdownRequestMessageSchema = lazySchema(() =>
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

export const ShutdownApprovedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_approved'),
    requestId: z.string(),
    from: z.string(),
    timestamp: z.string(),
    paneId: z.string().optional(),
    backendType: z.string().optional(),
  }),
)
export type ShutdownApprovedMessage = z.infer<ReturnType<typeof ShutdownApprovedMessageSchema>>

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

export const ShutdownRejectedMessageSchema = lazySchema(() =>
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

export type TeamPermissionUpdateMessage = {
  type: 'team_permission_update'
  permissionUpdate: {
    type: 'addRules'
    rules: Array<{ toolName: string; ruleContent?: string }>
    behavior: 'allow' | 'deny' | 'ask'
    destination: 'session'
  }
  directoryPath: string
  toolName: string
}

export function isTeamPermissionUpdate(text: string): TeamPermissionUpdateMessage | null {
  const parsed = parseStructuredText(text)
  if (!parsed || parsed.type !== 'team_permission_update') return null
  return parsed as TeamPermissionUpdateMessage
}

export const ModeSetRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('mode_set_request'),
    mode: z.custom<InternalPermissionMode>(
      value => typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value),
    ),
    from: z.string(),
  }),
)
export type ModeSetRequestMessage = z.infer<ReturnType<typeof ModeSetRequestMessageSchema>>

export function createModeSetRequestMessage(params: {
  mode: ModeSetRequestMessage['mode']
  from: string
}): ModeSetRequestMessage {
  return { type: 'mode_set_request', mode: params.mode, from: params.from }
}

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
  'team_permission_update',
  'mode_set_request',
  'plan_approval_request',
  'plan_approval_response',
])

export function isStructuredProtocolMessage(messageText: string): boolean {
  const parsed = parseStructuredText(messageText)
  if (!parsed || typeof parsed.type !== 'string') return false
  return STRUCTURED_PROTOCOL_TYPES.has(parsed.type)
}

export async function sendShutdownRequestToMailbox(
  targetName: string,
  teamName?: string,
  reason?: string,
): Promise<{ requestId: string; target: string }> {
  const team = teamName ?? getTeamName()
  const sender = getAgentName() ?? TEAM_LEAD_NAME
  const requestId = generateRequestId('shutdown', targetName)
  const request = createShutdownRequestMessage({ requestId, from: sender, reason })
  await writeToMailbox(
    targetName,
    {
      from: sender,
      text: JSON.stringify(request),
      timestamp: new Date().toISOString(),
      ...(getTeammateColor() !== undefined ? { color: getTeammateColor() } : {}),
    },
    team,
  )
  return { requestId, target: targetName }
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
      if (to.toLowerCase() === TEAM_LEAD_NAME.toLowerCase()) continue
      const body = block.input?.message
      if (typeof body !== 'string') continue
      const summary = block.input?.summary
      const gist = typeof summary === 'string' ? summary : body.slice(0, DM_GIST_LENGTH)
      return `[DM to ${to}] ${gist}`
    }
  }
  return undefined
}
