import type { ToolUseBlockParam } from '../../types/wire.js'
import type { HookEvent } from '../hooks/contract.js'
import type { AssistantMessage, AttachmentMessage, Message, NormalizedMessage, NormalizedUserMessage, ProgressMessage } from '../../types/message.js'
import type { HookAttachment } from '../attachments.js'
import { isContinuableStreamFaultMessage, isStreamFaultRecoveryNudgeText } from '../../services/api/errors.js'
import { contentBlocksOf } from './normalize.js'
import { accumulateOpenToolUses, freshOpenToolUses } from './openToolUses.js'
import { isDenialResultText } from './rejectionText.js'

type HookCounts = Map<string, Map<HookEvent, number>>
export type MessageLookups = {
  normalizedMessageCount: number
  toolUseByToolUseID: Map<string, ToolUseBlockParam>
  toolResultByToolUseID: Map<string, NormalizedMessage>
  siblingToolUseIDs: Map<string, Set<string>>
  resolvedToolUseIDs: Set<string>
  erroredToolUseIDs: Set<string>
  deniedToolUseIDs: Set<string>
  progressMessagesByToolUseID: Map<string, ProgressMessage[]>
  inProgressHookCounts: HookCounts
  resolvedHookCounts: HookCounts
  recoveredStreamFaultUuids: Set<string>
}

function emptyIndexes(): MessageLookups {
  return {
    normalizedMessageCount: 0,
    toolUseByToolUseID: new Map(), toolResultByToolUseID: new Map(), siblingToolUseIDs: new Map(),
    resolvedToolUseIDs: new Set(), erroredToolUseIDs: new Set(), deniedToolUseIDs: new Set(),
    progressMessagesByToolUseID: new Map(), inProgressHookCounts: new Map(), resolvedHookCounts: new Map(),
    recoveredStreamFaultUuids: new Set(),
  }
}

export const EMPTY_LOOKUPS: MessageLookups = emptyIndexes()
export const EMPTY_STRING_SET: ReadonlySet<string> = Object.freeze(new Set<string>())

function bucket<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key)
  if (value === undefined) map.set(key, value = create())
  return value
}

function indexCalls(target: Map<string, ToolUseBlockParam>, body: unknown, accept?: (id: string) => void): void {
  for (const block of contentBlocksOf(body)) {
    if (block.type !== 'tool_use') continue
    target.set(block.id, block)
    accept?.(block.id)
  }
}

function indexCallGraph(rows: Message[], index: MessageLookups): void {
  const groups = new Map<string, Set<string>>()
  const owners = new Map<string, string>()
  for (const row of rows) {
    if (row.type !== 'assistant') continue
    const group = bucket(groups, row.message.id, () => new Set<string>())
    indexCalls(index.toolUseByToolUseID, row.message.content, id => {
      group.add(id)
      owners.set(id, row.message.id)
    })
  }
  for (const [id, owner] of owners) index.siblingToolUseIDs.set(id, groups.get(owner)!)
}

function indexProgress(row: ProgressMessage, index: MessageLookups): void {
  const id = row.parentToolUseID
  bucket(index.progressMessagesByToolUseID, id, () => []).push(row)
  if (row.data.type !== 'hook_progress') return
  const plane = row.data.state === 'running' ? index.inProgressHookCounts : index.resolvedHookCounts
  const counts = bucket(plane, id, () => new Map<HookEvent, number>())
  counts.set(row.data.event, 1 + (counts.get(row.data.event) ?? 0))
}

function toolResultText(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : ''
  return value.map(item => item && typeof item === 'object' && item.type === 'text' ? String(item.text ?? '') : '').join('\n')
}

function indexResults(row: NormalizedUserMessage, index: MessageLookups, classify: boolean): void {
  for (const block of contentBlocksOf(row.message.content)) {
    if (block.type !== 'tool_result') continue
    const id = block.tool_use_id
    index.toolResultByToolUseID.set(id, row)
    index.resolvedToolUseIDs.add(id)
    if (!classify || !block.is_error) continue
    index.erroredToolUseIDs.add(id)
    if (isDenialResultText(toolResultText(block.content))) index.deniedToolUseIDs.add(id)
  }
}

function recoveryTracker(recovered: Set<string>): (row: NormalizedMessage) => void {
  const pending: string[] = []
  return row => {
    if (row.type === 'assistant') {
      if (isContinuableStreamFaultMessage(row as unknown as AssistantMessage)) pending.push(row.uuid)
      return
    }
    if (!pending.length) return
    const cut = row.type === 'system' && row.subtype === 'stream_cut'
    const user = row.type === 'user' && Array.isArray(row.message.content)
    if (!cut && !user) return
    const resumes = cut || (row.type === 'user' && row.message.content.some(block => block.type === 'text' && isStreamFaultRecoveryNudgeText(block.text)))
    if (resumes) for (const id of pending) recovered.add(id)
    pending.length = 0
  }
}

function closeServerCalls(rows: NormalizedMessage[], last: Message | undefined, index: MessageLookups): void {
  const streamingId = last?.type === 'assistant' ? last.message.id : undefined
  for (const row of rows) {
    if (row.type !== 'assistant' || row.message.id === streamingId) continue
    for (const block of contentBlocksOf(row.message.content)) {
      if (block.type !== 'server_tool_use' && block.type !== 'mcp_tool_use') continue
      if (index.resolvedToolUseIDs.has(block.id)) continue
      index.resolvedToolUseIDs.add(block.id)
      index.erroredToolUseIDs.add(block.id)
    }
  }
}

export function buildMessageLookups(normalizedMessages: NormalizedMessage[], messages: Message[]): MessageLookups {
  const index = emptyIndexes()
  index.normalizedMessageCount = normalizedMessages.length
  indexCallGraph(messages, index)
  const trackRecovery = recoveryTracker(index.recoveredStreamFaultUuids)
  const open = freshOpenToolUses()
  const seen: string[] = []
  for (const row of normalizedMessages) {
    if (row.type === 'user' || row.type === 'assistant') accumulateOpenToolUses(open, row)
    trackRecovery(row)
    switch (row.type) {
      case 'progress': indexProgress(row, index); break
      case 'user': indexResults(row, index, true); break
      case 'assistant':
        for (const block of contentBlocksOf(row.message.content)) {
          if (block.type === 'tool_use') seen.push(block.id)
          if ('tool_use_id' in block && typeof block.tool_use_id === 'string') index.resolvedToolUseIDs.add(block.tool_use_id)
        }
    }
  }
  for (const id of seen) if (!open.owners.has(id)) index.resolvedToolUseIDs.add(id)
  closeServerCalls(normalizedMessages, messages.at(-1), index)
  return index
}

export function buildSubagentLookups(messages: { message: AssistantMessage | NormalizedUserMessage }[]): {
  lookups: MessageLookups; inProgressToolUseIDs: Set<string>
} {
  const lookups: MessageLookups = {
    ...EMPTY_LOOKUPS, toolUseByToolUseID: new Map(), toolResultByToolUseID: new Map(), resolvedToolUseIDs: new Set(),
  }
  const open = freshOpenToolUses()
  for (const entry of messages) {
    const row = entry.message
    accumulateOpenToolUses(open, row)
    if (row.type === 'assistant') indexCalls(lookups.toolUseByToolUseID, row.message.content)
    else if (row.type === 'user') indexResults(row, lookups, false)
  }
  const inProgressToolUseIDs = new Set<string>()
  lookups.toolUseByToolUseID.forEach((_, id) => {
    const plane = open.owners.has(id) ? inProgressToolUseIDs : lookups.resolvedToolUseIDs
    plane.add(id)
  })
  return { lookups, inProgressToolUseIDs }
}

export function isHookAttachmentMessage(message: Message): message is AttachmentMessage<HookAttachment> {
  return message.type === 'attachment' && message.attachment.type === 'hook'
}

export function getToolUseID(message: NormalizedMessage): string | null {
  if (message.type === 'progress') return message.toolUseID
  if (message.type === 'attachment') return isHookAttachmentMessage(message) ? message.attachment.callId ?? null : null
  if (message.type === 'system') return message.subtype === 'informational' ? message.toolUseID ?? null : null
  const first = message.message.content[0]
  if (message.type === 'user') return message.sourceToolUseID || (first?.type === 'tool_result' ? first.tool_use_id : null)
  return first?.type === 'tool_use' ? first.id : null
}

export function getSiblingToolUseIDsFromLookup(message: NormalizedMessage, lookups: MessageLookups): ReadonlySet<string> {
  const id = getToolUseID(message)
  return (id ? lookups.siblingToolUseIDs.get(id) : undefined) ?? EMPTY_STRING_SET
}

export function getProgressMessagesFromLookup(message: NormalizedMessage, lookups: MessageLookups): ProgressMessage[] {
  const id = getToolUseID(message)
  return (id ? lookups.progressMessagesByToolUseID.get(id) : undefined) ?? []
}

export function hasUnresolvedHooksFromLookup(toolUseID: string, hookEvent: HookEvent, lookups: MessageLookups): boolean {
  const at = (plane: HookCounts): number => plane.get(toolUseID)?.get(hookEvent) ?? 0
  return at(lookups.inProgressHookCounts) > at(lookups.resolvedHookCounts)
}

export function hasUnresolvedHooks(messages: NormalizedMessage[], toolUseID: string, hookEvent: HookEvent) {
  let balance = 0
  for (const row of messages) {
    if (row.type !== 'progress' || row.parentToolUseID !== toolUseID || row.data.type !== 'hook_progress' || row.data.event !== hookEvent) continue
    if (row.data.state === 'running') balance++
    if (row.data.state === 'ran') balance--
  }
  return balance > 0
}

export function getToolResultIDs(normalizedMessages: NormalizedMessage[]): { [toolUseID: string]: boolean } {
  const entries: [string, boolean][] = []
  for (const row of normalizedMessages) {
    if (row.type !== 'user') continue
    const first = row.message.content[0]
    if (first?.type === 'tool_result') entries.push([first.tool_use_id, first.is_error ?? false])
  }
  return Object.fromEntries(entries)
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
  if (!id) return siblings
  const owner = messages.find(row => row.type === 'assistant' &&
    contentBlocksOf(row.message.content).some(block => block.type === 'tool_use' && block.id === id))
  if (owner?.type !== 'assistant') return siblings
  for (const row of messages) {
    if (row.type !== 'assistant' || row.message.id !== owner.message.id) continue
    for (const block of contentBlocksOf(row.message.content)) if (block.type === 'tool_use') siblings.add(block.id)
  }
  return siblings
}

export function getLastAssistantMessage(messages: Message[]): AssistantMessage | undefined {
  return messages.findLast((row): row is AssistantMessage => row.type === 'assistant')
}

export function hasToolCallsInLastAssistantTurn(messages: Message[]): boolean {
  const row = messages.findLast(item => item?.type === 'assistant' && Array.isArray(item.message.content))
  if (row?.type !== 'assistant') return false
  const blocks = row.message.content
  return blocks.some(block => block.type === 'tool_use')
}
