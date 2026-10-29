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
import { isTurnCutText } from './turnCut.js'
import { pairConversationMessages } from './pairing.js'
import { dropEmptyTextBlocks, filterOrphanedThinkingOnlyMessages, filterTrailingThinkingFromLastAssistant, filterWhitespaceOnlyAssistantMessages, ensureNonEmptyAssistantContent, sanitizeErrorToolResultContent } from './apiFilters.js'
import { stripToolReferenceBlocksFromUserMessage, stripUnavailableToolReferencesFromUserMessage, withToolReferenceTurnBoundary } from './apiView.js'
import { isToolSearchEnabledOptimistic } from '../toolSearch.js'
import { normalizeToolInputForAPI } from '../api.js'
import { toolMatchesName } from '../../Tool.js'
import { validateImagesForAPI } from '../imageValidation.js'
import { LOCAL_COMMAND_CAVEAT_TAG } from '../../constants/xml.js'
import { IMAGE_ELIDED_TEXT } from './imageRequestFit.js'
const CAVEAT_MARK = `<${LOCAL_COMMAND_CAVEAT_TAG}>`

function leadingTextOf(message: UserMessage): string {
  const content = message.message.content
  if (typeof content === 'string') return content
  const block = content.find(candidate => candidate.type === 'text') as { text?: string } | undefined
  return block?.text ?? ''
}

export function isLocalCommandCaveat(message: Message): message is UserMessage {
  return message.type === 'user' && message.isMeta === true && leadingTextOf(message).trimStart().startsWith(CAVEAT_MARK)
}

function closesCaveatBatch(message: Message): boolean {
  if (message.type === 'assistant') return true
  if (message.type !== 'user') return false
  return message.permissionMode !== undefined || isToolResultMessage(message) || isLocalCommandCaveat(message)
}

export function withoutOrphanCaveats<M extends Message>(messages: M[]): M[] {
  const orphaned = (index: number): boolean => {
    let at = index + 1
    while (messages[at]?.type === 'attachment') at++
    const next = messages[at]
    return next === undefined || closesCaveatBatch(next)
  }
  if (!messages.some((message, index) => isLocalCommandCaveat(message) && orphaned(index))) return messages
  return messages.filter((message, index) => !(isLocalCommandCaveat(message) && orphaned(index)))
}

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

function stripTargetsOf(rows: Message[]): Map<string, Set<string>> {
  const refusals = Object.fromEntries(([
    [getPdfTooLargeErrorMessage(), ['document']],
    [getPdfPasswordProtectedErrorMessage(), ['document']],
    [getPdfInvalidErrorMessage(), ['document']],
    [getImageTooLargeErrorMessage(), ['image']],
    [getRequestTooLargeErrorMessage(), ['document', 'image']],
  ] as Array<[string, string[]]>).map(([words, kinds]) => [words, new Set(kinds)]))
  const targets = new Map<string, Set<string>>()
  let eligible: UserMessage | undefined
  for (const row of rows) {
    const refused = refusedBlockTypesOf(row, refusals)
    if (eligible && refused) {
      const kinds = targets.get(eligible.uuid) ?? new Set<string>()
      refused.forEach(kind => kinds.add(kind))
      targets.set(eligible.uuid, kinds)
    }
    if (!isSyntheticApiErrorMessage(row)) eligible = row.type === 'user' && row.isMeta ? row : undefined
  }
  return targets
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
  const filtered = content.flatMap(block => !typesToStrip.has(block.type) ? [block] : block.type === 'image' ? [{ type: 'text' as const, text: IMAGE_ELIDED_TEXT }] : [])
  if (filtered.length === 0) return null
  if (filtered.some((block, index) => block !== content[index]) || filtered.length < content.length) {
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
    if (block.type === 'image') { out.push({ type: 'text', text: IMAGE_ELIDED_TEXT }); continue }
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const kept = (block.content as Array<{ type?: string }>).map(nested => nested.type === 'image' ? { type: 'text', text: IMAGE_ELIDED_TEXT } : nested)
      if (kept.every((nested, index) => nested === (block.content as unknown[])[index])) out.push(block)
      else out.push({ ...block, content: kept })
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

function refusedTurnIdsOf(rows: readonly Message[]): Set<string> {
  const refused = new Set<string>()
  for (const row of rows) {
    if (row.type !== 'assistant' || isSyntheticApiErrorMessage(row)) continue
    if (row.message.stop_reason === 'refusal') refused.add(row.message.id)
  }
  if (refused.size === 0) return refused
  for (const row of rows) {
    if (row.type !== 'assistant' || !refused.has(row.message.id)) continue
    const content = row.message.content
    if (Array.isArray(content) && content.some(block => block.type === 'tool_use')) refused.delete(row.message.id)
  }
  return refused
}

export function planApiConversation(
  messages: Message[],
  tools: Tools = [],
): ApiConversationPlan {
  const availableToolNames = new Set(tools.map(t => t.name))

  const reorderedMessages = modelRelevantOrder(messages)
  const stripTargets = stripTargetsOf(reorderedMessages)
  const refusedTurns = refusedTurnIdsOf(reorderedMessages)

  const selected = foldBatchedRows(
    withoutOrphanCaveats(
      reorderedMessages.flatMap((m): PlannedMessage[] => {
        if (m.type === 'progress' || (m.type === 'system' && !isSystemLocalCommandMessage(m))) {
          return []
        }
        if (isSyntheticApiErrorMessage(m)) return []
        if (m.type === 'assistant' && refusedTurns.has(m.message.id)) return []
        return [m as PlannedMessage]
      }),
    ),
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
  const refusedTurns = geometry === 'family' ? refusedTurnIdsOf(messages) : new Set<string>()
  const selection = geometry === 'anthropic'
    ? planApiConversation(messages as Message[], tools)
    : {
      selected: withoutOrphanCaveats(messages.filter((message): message is PlannedMessage =>
        !(message.type === 'assistant' && refusedTurns.has(message.message.id)) &&
        (((message.type === 'user' || message.type === 'assistant') && !message.isVirtual) ||
        message.type === 'attachment' || isSystemLocalCommandMessage(message)))),
      stripTargets: new Map<string, Set<string>>(),
      availableToolNames: new Set(tools.map(tool => tool.name)),
    }
  const projected = projectConversationSelection(selection, tools, geometry)
  const prepared = geometry === 'family'
    ? pairConversationMessages(stripImagesRefusedByStamp(projected).filter(message => !isSyntheticApiErrorMessage(message)), 'split')
    : finishApiContent(projected)
  return { ...selection, selected: selection.selected.filter(message => !isSyntheticApiErrorMessage(message)), messages: mergeAdjacentUsers(prepared) }
}

function mergeAdjacentUsers(messages: (UserMessage | AssistantMessage)[]): (UserMessage | AssistantMessage)[] {
  const kindOf = (row: UserMessage): 'text' | 'tool_result' | null => {
    const content = row.message.content
    if (typeof content === 'string') return 'text'
    const kind = content[0]?.type
    return (kind === 'text' || kind === 'tool_result') && content.every(block => block.type === kind) ? kind : null
  }
  const carriesCut = (row: UserMessage): boolean => {
    const content = row.message.content
    return typeof content === 'string' ? isTurnCutText(content) : content.some(block => block.type === 'text' && isTurnCutText(block.text))
  }
  const out: (UserMessage | AssistantMessage)[] = []
  for (const row of messages) {
    const previous = out.at(-1)
    const kind = row.type === 'user' ? kindOf(row) : null
    const stacked = row.type === 'user' && previous?.type === 'user' && kind !== null && kind === kindOf(previous)
    const cutRun = stacked && (kind === 'tool_result' || carriesCut(previous) || carriesCut(row))
    if (stacked && cutRun && previous.type === 'user' && row.type === 'user') out[out.length - 1] = mergeUserMessages(previous, row)
    else out.push(row)
  }
  return out.length === messages.length ? messages : out
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
