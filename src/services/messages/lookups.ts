import type { ToolUseBlockParam } from '../../types/wire.js'
import type { HookEvent } from '../../utils/hooks/contract.js'
import type { AssistantMessage, AttachmentMessage, Message, NormalizedMessage, NormalizedUserMessage, ProgressMessage } from '../../types/message.js'
import type { HookAttachment } from '../../utils/attachments/types.js'
import { isContinuableStreamFaultMessage, isStreamFaultRecoveryNudgeText } from '../api/errors.js'
import { contentBlocksOf } from '../../utils/messages/normalize.js'
import { accumulateOpenToolUses, freshOpenToolUses } from '../../utils/messages/openToolUses.js'
import { isDenialResultText } from '../../utils/messages/rejectionText.js'
export type MessageLookups = {
  normalizedMessageCount: number
  toolUseByToolUseID: Map<string, ToolUseBlockParam>
  toolResultByToolUseID: Map<string, NormalizedMessage>
  siblingToolUseIDs: Map<string, Set<string>>
  progressMessagesByToolUseID: Map<string, ProgressMessage[]>
  inProgressHookCounts: Map<string, Map<HookEvent, number>>
  resolvedHookCounts: Map<string, Map<HookEvent, number>>
  resolvedToolUseIDs: Set<string>
  erroredToolUseIDs: Set<string>
  deniedToolUseIDs: Set<string>
  recoveredStreamFaultUuids: Set<string>
}

function emptyLookups(): MessageLookups {
  return {
    normalizedMessageCount: 0,
    toolUseByToolUseID: new Map(),
    toolResultByToolUseID: new Map(),
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    resolvedToolUseIDs: new Set(),
    erroredToolUseIDs: new Set(),
    deniedToolUseIDs: new Set(),
    recoveredStreamFaultUuids: new Set(),
  }
}

export const EMPTY_LOOKUPS: MessageLookups = emptyLookups()
export const EMPTY_STRING_SET: ReadonlySet<string> = Object.freeze(new Set<string>())

function indexRawCalls(lookups: MessageLookups, messages: Message[]): void {
  const groups = new Map<string, Set<string>>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const messageId = message.message.id
    const group = groups.get(messageId) ?? new Set<string>()
    groups.set(messageId, group)
    for (const block of contentBlocksOf(message.message.content)) {
      if (block.type !== 'tool_use') continue
      lookups.toolUseByToolUseID.set(block.id, block)
      lookups.siblingToolUseIDs.set(block.id, group)
      group.add(block.id)
    }
  }
}

function countHookProgress(lookups: MessageLookups, row: ProgressMessage): void {
  const { data } = row
  if (data.type !== 'hook_progress') return
  const plane = data.state === 'running' ? lookups.inProgressHookCounts : lookups.resolvedHookCounts
  const counts = plane.get(row.parentToolUseID) ?? new Map<HookEvent, number>()
  plane.set(row.parentToolUseID, counts)
  counts.set(data.event, (counts.get(data.event) ?? 0) + 1)
}

function resultTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((item: { type?: string; text?: string | null }) => (item.type === 'text' ? item.text ?? '' : '')).join('\n')
}

function indexUserResults(lookups: MessageLookups, row: NormalizedUserMessage): void {
  for (const block of contentBlocksOf(row.message.content)) {
    if (block.type !== 'tool_result') continue
    lookups.toolResultByToolUseID.set(block.tool_use_id, row)
    lookups.resolvedToolUseIDs.add(block.tool_use_id)
    if (!block.is_error) continue
    lookups.erroredToolUseIDs.add(block.tool_use_id)
    if (isDenialResultText(resultTextOf(block.content))) lookups.deniedToolUseIDs.add(block.tool_use_id)
  }
}

export function buildMessageLookups(normalizedMessages: NormalizedMessage[], messages: Message[]): MessageLookups {
  const lookups = emptyLookups()
  lookups.normalizedMessageCount = normalizedMessages.length
  indexRawCalls(lookups, messages)

  const open = freshOpenToolUses()
  const normalizedCalls = new Set<string>()
  const hostedCalls: { id: string; messageId: string | undefined }[] = []
  let pendingFaults: string[] = []
  const recoverPending = (): void => {
    for (const uuid of pendingFaults) lookups.recoveredStreamFaultUuids.add(uuid)
  }
  for (const row of normalizedMessages) {
    if (row.type === 'progress') {
      const held = lookups.progressMessagesByToolUseID.get(row.parentToolUseID) ?? []
      lookups.progressMessagesByToolUseID.set(row.parentToolUseID, held)
      held.push(row)
      countHookProgress(lookups, row)
      continue
    }
    if (row.type === 'system') {
      if (row.subtype !== 'stream_cut') continue
      recoverPending()
      pendingFaults = []
      continue
    }
    if (row.type === 'user') {
      accumulateOpenToolUses(open, row)
      indexUserResults(lookups, row)
      const { content } = row.message
      if (!Array.isArray(content)) continue
      if (content.some(block => block.type === 'text' && isStreamFaultRecoveryNudgeText(block.text))) recoverPending()
      pendingFaults = []
      continue
    }
    if (row.type !== 'assistant') continue
    accumulateOpenToolUses(open, row)
    if (isContinuableStreamFaultMessage(row)) pendingFaults.push(row.uuid)
    for (const block of contentBlocksOf(row.message.content)) {
      if (block.type === 'tool_use') normalizedCalls.add(block.id)
      if (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') hostedCalls.push({ id: block.id, messageId: row.message.id })
      if ('tool_use_id' in block && typeof block.tool_use_id === 'string') lookups.resolvedToolUseIDs.add(block.tool_use_id)
    }
  }
  for (const id of normalizedCalls) {
    if (!open.owners.has(id)) lookups.resolvedToolUseIDs.add(id)
  }

  const lastRaw = messages.at(-1)
  const streamingId = lastRaw?.type === 'assistant' ? lastRaw.message.id : undefined
  for (const hosted of hostedCalls) {
    if (lookups.resolvedToolUseIDs.has(hosted.id) || hosted.messageId === streamingId) continue
    lookups.resolvedToolUseIDs.add(hosted.id)
    lookups.erroredToolUseIDs.add(hosted.id)
  }
  return lookups
}

export function buildSubagentLookups(messages: { message: AssistantMessage | NormalizedUserMessage }[]): {
  lookups: MessageLookups; inProgressToolUseIDs: Set<string>
} {
  const open = freshOpenToolUses()
  const toolUseByToolUseID: MessageLookups['toolUseByToolUseID'] = new Map()
  const toolResultByToolUseID: MessageLookups['toolResultByToolUseID'] = new Map()
  const resolvedToolUseIDs = new Set<string>()
  for (const { message } of messages) {
    accumulateOpenToolUses(open, message)
    for (const block of contentBlocksOf(message.message.content)) {
      if (message.type === 'assistant') {
        if (block.type === 'tool_use') toolUseByToolUseID.set(block.id, block)
        continue
      }
      if (block.type !== 'tool_result') continue
      toolResultByToolUseID.set(block.tool_use_id, message)
      resolvedToolUseIDs.add(block.tool_use_id)
    }
  }
  const inProgressToolUseIDs = new Set<string>()
  for (const id of toolUseByToolUseID.keys()) (open.owners.has(id) ? inProgressToolUseIDs : resolvedToolUseIDs).add(id)
  return { lookups: { ...EMPTY_LOOKUPS, toolUseByToolUseID, toolResultByToolUseID, resolvedToolUseIDs }, inProgressToolUseIDs }
}

export function isHookAttachmentMessage(message: Message): message is AttachmentMessage<HookAttachment> {
  return message.type === 'attachment' && message.attachment.type === 'hook'
}

export function getToolUseID(message: NormalizedMessage): string | null {
  switch (message.type) {
    case 'progress':
      return message.toolUseID
    case 'attachment':
      return isHookAttachmentMessage(message) ? message.attachment.callId ?? null : null
    case 'system':
      return message.subtype === 'informational' ? message.toolUseID ?? null : null
    case 'user': {
      if (message.sourceToolUseID) return message.sourceToolUseID
      const first = message.message.content[0]
      return first?.type === 'tool_result' ? first.tool_use_id : null
    }
    case 'assistant': {
      const first = message.message.content[0]
      return first?.type === 'tool_use' ? first.id : null
    }
  }
}

export function getSiblingToolUseIDsFromLookup(message: NormalizedMessage, lookups: MessageLookups): ReadonlySet<string> {
  const id = getToolUseID(message)
  return (id === null ? undefined : lookups.siblingToolUseIDs.get(id)) ?? EMPTY_STRING_SET
}

export function getProgressMessagesFromLookup(message: NormalizedMessage, lookups: MessageLookups): ProgressMessage[] {
  const id = getToolUseID(message)
  return (id === null ? undefined : lookups.progressMessagesByToolUseID.get(id)) ?? []
}

export function hasUnresolvedHooksFromLookup(toolUseID: string, hookEvent: HookEvent, lookups: MessageLookups): boolean {
  return (lookups.inProgressHookCounts.get(toolUseID)?.get(hookEvent) ?? 0) > (lookups.resolvedHookCounts.get(toolUseID)?.get(hookEvent) ?? 0)
}

export function hasUnresolvedHooks(messages: NormalizedMessage[], toolUseID: string, hookEvent: HookEvent): boolean {
  let balance = 0
  for (const row of messages) {
    if (row.type !== 'progress' || row.parentToolUseID !== toolUseID) continue
    const { data } = row
    if (data.type !== 'hook_progress' || data.event !== hookEvent) continue
    if (data.state === 'running') balance += 1
    else if (data.state === 'ran') balance -= 1
  }
  return balance > 0
}

export function getToolResultIDs(normalizedMessages: NormalizedMessage[]): { [toolUseID: string]: boolean } {
  const results: [string, boolean][] = []
  for (const row of normalizedMessages) {
    if (row.type !== 'user') continue
    const first = row.message.content[0]
    if (first?.type === 'tool_result') results.push([first.tool_use_id, first.is_error ?? false])
  }
  return Object.fromEntries(results)
}

export function getToolUseIDs(normalizedMessages: NormalizedMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const row of normalizedMessages) {
    if (row.type !== 'assistant' || !Array.isArray(row.message.content)) continue
    const first = row.message.content[0]
    if (first?.type === 'tool_use') ids.add(first.id)
  }
  return ids
}

export function getSiblingToolUseIDs(message: NormalizedMessage, messages: Message[]): Set<string> {
  const siblings = new Set<string>()
  const id = getToolUseID(message)
  const callsOf = (row: AssistantMessage): string[] => contentBlocksOf(row.message.content).flatMap(block => (block.type === 'tool_use' ? [block.id] : []))
  const owner = id === null ? undefined : messages.find((row): row is AssistantMessage => row.type === 'assistant' && callsOf(row).includes(id))
  if (owner === undefined) return siblings
  for (const row of messages) {
    if (row.type !== 'assistant' || row.message.id !== owner.message.id) continue
    for (const call of callsOf(row)) siblings.add(call)
  }
  return siblings
}

export function getLastAssistantMessage(messages: Message[]): AssistantMessage | undefined {
  return messages.findLast((message): message is AssistantMessage => message.type === 'assistant')
}

export function hasToolCallsInLastAssistantTurn(messages: Message[]): boolean {
  const last = messages.findLast((message): message is AssistantMessage => message?.type === 'assistant' && Array.isArray(message.message.content))
  return last !== undefined && last.message.content.some(block => block.type === 'tool_use')
}
