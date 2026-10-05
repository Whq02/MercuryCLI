import type { Tools } from '../../Tool.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemLocalCommandMessage,
  UserMessage,
} from '../../types/message.js'
import {
  getImageTooLargeErrorMessage,
  getPdfInvalidErrorMessage,
  getPdfPasswordProtectedErrorMessage,
  getPdfTooLargeErrorMessage,
  getRequestTooLargeErrorMessage,
} from '../../services/api/errors.js'
import { mediaRefusalOf } from '../../services/api/mediaRefusal.js'
import { isSyntheticApiErrorMessage } from './factories.js'
import {
  isSystemLocalCommandMessage,
  reorderAttachmentsForAPI,
} from './apiView.js'
import { joinBatchedContent } from './batchedContent.js'
import { storedBlocksOf } from '../../rows/content.js'
import { normalizeAttachmentForAPI } from './attachmentText.js'
import { createUserMessage } from './factories.js'
import { mergeAssistantMessages, mergeUserMessages, mergeUserMessagesAndToolResults, isToolResultMessage } from './merge.js'
import { pairConversationMessages } from './pairing.js'
import { dropEmptyTextBlocks, filterOrphanedThinkingOnlyMessages, filterTrailingThinkingFromLastAssistant, filterWhitespaceOnlyAssistantMessages, ensureNonEmptyAssistantContent, sanitizeErrorToolResultContent } from './apiFilters.js'
import { stripToolReferenceBlocksFromUserMessage, stripUnavailableToolReferencesFromUserMessage, withToolReferenceTurnBoundary } from './apiView.js'
import { isToolSearchEnabledOptimistic } from '../toolSearch.js'
import { normalizeToolInputForAPI } from '../api.js'
import { toolMatchesName } from '../../Tool.js'
import { validateImagesForAPI } from '../imageValidation.js'

export type PlannedMessage =
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemLocalCommandMessage

export type ApiConversationPlan = {
  selected: PlannedMessage[]
  stripTargets: Map<string, Set<string>>
  availableToolNames: Set<string>
}

function modelRelevantOrder(messages: Message[]): Message[] {
  return reorderAttachmentsForAPI(messages).filter(
    m => !((m.type === 'user' || m.type === 'assistant') && m.isVirtual),
  )
}

function refusedBlockTypesOf(
  msg: Message,
  errorToBlockTypes: Record<string, Set<string>>,
): Set<string> | undefined {
  if (!isSyntheticApiErrorMessage(msg)) return undefined
  const errorText =
    Array.isArray(msg.message.content) &&
    msg.message.content[0]?.type === 'text'
      ? msg.message.content[0].text
      : undefined
  const byText = errorText ? errorToBlockTypes[errorText] : undefined
  if (byText) return byText
  const stamped = mediaRefusalOf(msg)
  return stamped === null ? undefined : new Set<string>(stamped.blockTypes)
}

function stripTargetsOf(reorderedMessages: Message[]): Map<string, Set<string>> {
  const errorToBlockTypes: Record<string, Set<string>> = {
    [getPdfTooLargeErrorMessage()]: new Set(['document']),
    [getPdfPasswordProtectedErrorMessage()]: new Set(['document']),
    [getPdfInvalidErrorMessage()]: new Set(['document']),
    [getImageTooLargeErrorMessage()]: new Set(['image']),
    [getRequestTooLargeErrorMessage()]: new Set(['document', 'image']),
  }

  const stripTargets = new Map<string, Set<string>>()
  for (let i = 0; i < reorderedMessages.length; i++) {
    const msg = reorderedMessages[i]!
    const blockTypesToStrip = refusedBlockTypesOf(msg, errorToBlockTypes)
    if (!blockTypesToStrip) {
      continue
    }
    for (let j = i - 1; j >= 0; j--) {
      const candidate = reorderedMessages[j]!
      if (candidate.type === 'user' && candidate.isMeta) {
        const existing = stripTargets.get(candidate.uuid)
        if (existing) {
          for (const t of blockTypesToStrip) {
            existing.add(t)
          }
        } else {
          stripTargets.set(candidate.uuid, new Set(blockTypesToStrip))
        }
        break
      }
      if (isSyntheticApiErrorMessage(candidate)) {
        continue
      }
      break
    }
  }
  return stripTargets
}

export function errorDrivenStripTargets(messages: Message[]): Map<string, Set<string>> {
  return stripTargetsOf(modelRelevantOrder(messages))
}

export function applyStripTargets(
  message: UserMessage,
  stripTargets: ReadonlyMap<string, Set<string>>,
): UserMessage | null {
  const typesToStrip = stripTargets.get(message.uuid)
  if (!typesToStrip || !message.isMeta) return message
  const content = message.message.content
  if (!Array.isArray(content)) return message
  const filtered = content.filter(block => !typesToStrip.has(block.type))
  if (filtered.length === 0) return null
  if (filtered.length < content.length) {
    return { ...message, message: { ...message.message, content: filtered } }
  }
  return message
}

export function applyStripTargetsToMessages(
  messages: Message[],
  stripTargets: ReadonlyMap<string, Set<string>>,
): Message[] {
  if (stripTargets.size === 0) return messages
  const out: Message[] = []
  for (const message of messages) {
    if (message.type !== 'user') {
      out.push(message)
      continue
    }
    const kept = applyStripTargets(message, stripTargets)
    if (kept !== null) out.push(kept)
  }
  return out
}

function contentCarriesImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const block of content as Array<{ type?: string; content?: unknown }>) {
    if (block.type === 'image') return true
    if (block.type === 'tool_result' && Array.isArray(block.content) && (block.content as Array<{ type?: string }>).some(nested => nested.type === 'image')) return true
  }
  return false
}

function contentWithoutImages(content: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const block of content as Array<{ type?: string; content?: unknown }>) {
    if (block.type === 'image') continue
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const kept = (block.content as Array<{ type?: string }>).filter(nested => nested.type !== 'image')
      if (kept.length === block.content.length) out.push(block)
      else out.push({ ...block, content: kept.length > 0 ? kept : [{ type: 'text', text: '[image]' }] })
      continue
    }
    out.push(block)
  }
  return out
}

export function stripImagesRefusedByStamp<M extends Message>(rows: M[]): M[] {
  const targets = new Set<number>()
  for (let i = 0; i < rows.length; i++) {
    const stamp = mediaRefusalOf(rows[i])
    if (stamp === null || !stamp.blockTypes.includes('image')) continue
    for (let j = i - 1; j >= 0; j--) {
      const candidate = rows[j]!
      if (candidate.type !== 'user' || targets.has(j)) continue
      if (contentCarriesImage(candidate.message.content)) {
        targets.add(j)
        break
      }
    }
  }
  if (targets.size === 0) return rows
  return rows.map((row, index) => {
    if (!targets.has(index) || row.type !== 'user' || !Array.isArray(row.message.content)) return row
    const content = contentWithoutImages(row.message.content)
    return { ...row, message: { ...row.message, content } } as M
  })
}

export function planApiConversation(
  messages: Message[],
  tools: Tools = [],
): ApiConversationPlan {
  const availableToolNames = new Set(tools.map(t => t.name))

  const reorderedMessages = modelRelevantOrder(messages)
  const stripTargets = stripTargetsOf(reorderedMessages)

  const selected = foldBatchedRows(
    reorderedMessages.filter((m): m is PlannedMessage => {
      if (
        m.type === 'progress' ||
        (m.type === 'system' && !isSystemLocalCommandMessage(m)) ||
        isSyntheticApiErrorMessage(m)
      ) {
        return false
      }
      return true
    }),
  )

  return { selected, stripTargets, availableToolNames }
}

function foldBatchedRows(messages: PlannedMessage[]): PlannedMessage[] {
  const out: PlannedMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const head = messages[i]!
    const batch = head.type === 'user' ? head.batchUuids : undefined
    if (head.type !== 'user' || batch === undefined || batch.length < 2) {
      out.push(head)
      continue
    }
    const values: Array<string | ContentBlockParam[]> = [head.message.content]
    let j = i + 1
    for (; j < messages.length; j++) {
      const next = messages[j]!
      if (next.type !== 'user' || next.uuid === head.uuid || !batch.includes(next.uuid)) break
      values.push(next.message.content)
    }
    out.push(values.length === 1 ? head : { ...head, message: { ...head.message, content: joinBatchedContent(values) } })
    i = j - 1
  }
  return out
}
export interface RequestConversationPlan extends ApiConversationPlan {
  messages: (UserMessage | AssistantMessage)[]
}

export function requestConversationPlan(
  messages: readonly Message[],
  tools: Tools = [],
  geometry: 'anthropic' | 'family' = 'anthropic',
): RequestConversationPlan {
  const selection = geometry === 'anthropic'
    ? planApiConversation(messages as Message[], tools)
    : {
      selected: messages.filter((message): message is PlannedMessage =>
        ((message.type === 'user' || message.type === 'assistant') && !message.isVirtual) ||
        message.type === 'attachment' || isSystemLocalCommandMessage(message)),
      stripTargets: new Map<string, Set<string>>(),
      availableToolNames: new Set(tools.map(tool => tool.name)),
    }
  const projected = projectConversationSelection(selection, tools, geometry)
  const prepared = geometry === 'family' ? pairConversationMessages(projected, 'split') : finishApiContent(projected)
  return { ...selection, messages: prepared }
}

function projectConversationSelection(
  plan: ApiConversationPlan,
  tools: Tools,
  geometry: 'anthropic' | 'family',
): (UserMessage | AssistantMessage)[] {
  const out: (UserMessage | AssistantMessage)[] = []
  const putUser = (message: UserMessage, fromAttachment = false): void => {
    const previous = out.at(-1)
    if (geometry === 'anthropic' && previous?.type === 'user') {
      out[out.length - 1] = fromAttachment ? mergeUserMessagesAndToolResults(previous, message) : mergeUserMessages(previous, message)
    } else out.push(message)
  }
  for (const message of plan.selected) {
    if (message.type === 'attachment') {
      const projected = normalizeAttachmentForAPI(message.attachment)
      if (geometry === 'anthropic' && out.at(-1)?.type === 'user') {
        for (const row of projected) putUser(row, true)
      } else out.push(...projected)
      continue
    }
    if (message.type === 'system') {
      putUser(createUserMessage({ content: message.content, uuid: message.uuid, timestamp: message.timestamp }))
      continue
    }
    if (geometry === 'family') {
      out.push(message)
      continue
    }
    if (message.type === 'user') {
      const references = isToolSearchEnabledOptimistic()
        ? stripUnavailableToolReferencesFromUserMessage(message, plan.availableToolNames)
        : stripToolReferenceBlocksFromUserMessage(message)
      const kept = applyStripTargets(references, plan.stripTargets)
      if (kept !== null) putUser(withToolReferenceTurnBoundary(kept))
      continue
    }
    const toolSearch = isToolSearchEnabledOptimistic()
    const normalized: AssistantMessage = {
      ...message,
      message: {
        ...message.message,
        content: storedBlocksOf(message.message.content).map(block => {
          if (block.type !== 'tool_use') return block
          const tool = tools.find(candidate => toolMatchesName(candidate, block.name))
          const name = tool?.name ?? block.name
          const input = tool ? normalizeToolInputForAPI(tool, block.input as Record<string, unknown>) : block.input
          return toolSearch ? { ...block, name, input } : { type: 'tool_use' as const, id: block.id, name, input }
        }) as AssistantMessage['message']['content'],
      },
    }
    let joined = false
    for (let index = out.length - 1; index >= 0; index--) {
      const previous = out[index]!
      if (previous.type !== 'assistant' && !isToolResultMessage(previous)) break
      if (previous.type === 'assistant' && previous.message.id === normalized.message.id) {
        out[index] = mergeAssistantMessages(previous, normalized)
        joined = true
        break
      }
    }
    if (!joined) out.push(normalized)
  }
  return out
}

function finishApiContent(messages: (UserMessage | AssistantMessage)[]): (UserMessage | AssistantMessage)[] {
  let rows = messages
  for (const stage of [dropEmptyTextBlocks, filterOrphanedThinkingOnlyMessages, filterTrailingThinkingFromLastAssistant, filterWhitespaceOnlyAssistantMessages, ensureNonEmptyAssistantContent, sanitizeErrorToolResultContent]) {
    rows = stage(rows) as (UserMessage | AssistantMessage)[]
  }
  validateImagesForAPI(rows)
  return rows
}
