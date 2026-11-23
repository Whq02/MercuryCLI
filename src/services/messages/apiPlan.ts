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
} from '../api/errors.js'
import { mediaRefusalOf } from '../../utils/api/mediaRefusal.js'
import { isSyntheticApiErrorMessage } from '../../utils/messages/factories.js'
import {
  isSystemLocalCommandMessage,
  reorderAttachmentsForAPI,
} from './apiViewRows.js'
import { joinBatchedContent } from '../../utils/messages/batchedContent.js'
import { storedBlocksOf } from '../../rows/content.js'
import { normalizeAttachmentForAPI } from './attachmentText.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { mergeAssistantMessages, mergeUserMessages, mergeUserMessagesAndToolResults, isToolResultMessage } from './merge.js'
import { isTurnCutText } from '../../utils/messages/turnCut.js'
import { pairConversationMessages } from '../../utils/messages/resultPairing.js'
import { dropEmptyTextBlocks, filterOrphanedThinkingOnlyMessages, filterTrailingThinkingFromLastAssistant, filterWhitespaceOnlyAssistantMessages, ensureNonEmptyAssistantContent, sanitizeErrorToolResultContent } from './apiFilters.js'
import { stripToolReferenceBlocksFromUserMessage, stripUnavailableToolReferencesFromUserMessage, withToolReferenceTurnBoundary } from './apiViewRows.js'
import { isToolSearchEnabledOptimistic } from './toolSearch.js'
import { normalizeToolInputForAPI } from './api.js'
import { toolMatchesName } from '../../Tool.js'
import { validateImagesForAPI } from '../imageValidation.js'
import { LOCAL_COMMAND_CAVEAT_TAG } from '../../constants/xml.js'
import { IMAGE_ELIDED_TEXT } from '../../utils/messages/imageRequestFit.js'

function leadingTextOf(content: string | ContentBlockParam[]): string {
  if (typeof content === 'string') return content
  for (const block of content) {
    if (block.type === 'text') return block.text
  }
  return ''
}

export function isLocalCommandCaveat(message: Message): message is UserMessage {
  if (message.type !== 'user' || message.isMeta !== true) return false
  return leadingTextOf(message.message.content).trimStart().startsWith(`<${LOCAL_COMMAND_CAVEAT_TAG}>`)
}

function caveatIsOrphan(messages: readonly Message[], at: number): boolean {
  let next = at + 1
  while (messages[next]?.type === 'attachment') next += 1
  const row = messages[next]
  if (row === undefined || row.type === 'assistant') return true
  return row.type === 'user' && (row.permissionMode !== undefined || isToolResultMessage(row) || isLocalCommandCaveat(row))
}

export function withoutOrphanCaveats<M extends Message>(messages: M[]): M[] {
  const kept = messages.filter((row, at) => !isLocalCommandCaveat(row) || !caveatIsOrphan(messages, at))
  return kept.length === messages.length ? messages : kept
}

export type PlannedMessage = UserMessage | AssistantMessage | AttachmentMessage | SystemLocalCommandMessage

export type ApiConversationPlan = {
  selected: PlannedMessage[]
  stripTargets: Map<string, Set<string>>
  availableToolNames: Set<string>
}

function modelRelevantRows(messages: Message[]): Message[] {
  return reorderAttachmentsForAPI(messages).filter(row => !((row.type === 'user' || row.type === 'assistant') && row.isVirtual))
}

function refusedBlockTypesOf(row: AssistantMessage, diagnosed: Record<string, Set<string>>): Iterable<string> | undefined {
  const { content } = row.message
  const first = Array.isArray(content) ? content[0] : undefined
  const text = first?.type === 'text' ? first.text : ''
  const named = text ? diagnosed[text] : undefined
  return named || mediaRefusalOf(row)?.blockTypes
}

function stripTargetsAmong(rows: readonly Message[]): Map<string, Set<string>> {
  const diagnosed: Record<string, Set<string>> = {
    [getPdfTooLargeErrorMessage()]: new Set(['document']),
    [getPdfPasswordProtectedErrorMessage()]: new Set(['document']),
    [getPdfInvalidErrorMessage()]: new Set(['document']),
    [getImageTooLargeErrorMessage()]: new Set(['image']),
    [getRequestTooLargeErrorMessage()]: new Set(['document', 'image']),
  }
  const targets = new Map<string, Set<string>>()
  let eligible: UserMessage | undefined
  for (const row of rows) {
    if (!isSyntheticApiErrorMessage(row)) {
      eligible = row.type === 'user' && row.isMeta === true ? row : undefined
      continue
    }
    const types = eligible === undefined ? undefined : refusedBlockTypesOf(row, diagnosed)
    if (eligible === undefined || types === undefined) continue
    const held = targets.get(eligible.uuid) ?? new Set<string>()
    targets.set(eligible.uuid, held)
    for (const type of types) held.add(type)
  }
  return targets
}

export function errorDrivenStripTargets(messages: Message[]): Map<string, Set<string>> {
  return stripTargetsAmong(modelRelevantRows(messages))
}

function elidedImage(): ContentBlockParam {
  return { type: 'text', text: IMAGE_ELIDED_TEXT }
}

export function applyStripTargets(
  message: UserMessage,
  stripTargets: ReadonlyMap<string, Set<string>>,
): UserMessage | null {
  const targets = stripTargets.get(message.uuid)
  const { content } = message.message
  if (targets === undefined || message.isMeta !== true || typeof content === 'string') return message
  const filtered: ContentBlockParam[] = []
  for (const block of content) {
    if (!targets.has(block.type)) filtered.push(block)
    else if (block.type === 'image') filtered.push(elidedImage())
  }
  if (filtered.length === 0) return null
  if (filtered.length === content.length && filtered.every((block, at) => block === content[at])) return message
  return { ...message, message: { ...message.message, content: filtered } }
}

export function applyStripTargetsToMessages(
  messages: Message[],
  stripTargets: ReadonlyMap<string, Set<string>>,
): Message[] {
  if (stripTargets.size === 0) return messages
  const out: Message[] = []
  for (const row of messages) {
    const kept = row.type === 'user' ? applyStripTargets(row, stripTargets) : row
    if (kept !== null) out.push(kept)
  }
  return out
}

function resultHoldsImage(block: ContentBlockParam): boolean {
  return block.type === 'tool_result' && Array.isArray(block.content) && block.content.some(item => item.type === 'image')
}

function holdsImage(row: Message): boolean {
  if (row.type !== 'user' || typeof row.message.content === 'string') return false
  return row.message.content.some(block => block.type === 'image' || resultHoldsImage(block))
}

function withoutImages(block: ContentBlockParam): ContentBlockParam {
  if (block.type === 'image') return elidedImage()
  if (block.type !== 'tool_result' || !Array.isArray(block.content) || !resultHoldsImage(block)) return block
  return { ...block, content: block.content.map(item => (item.type === 'image' ? { type: 'text', text: IMAGE_ELIDED_TEXT } : item)) }
}

function withImagesElided<M extends Message>(row: M): M {
  if (row.type !== 'user' || typeof row.message.content === 'string') return row
  return { ...row, message: { ...row.message, content: row.message.content.map(withoutImages) } }
}

export function stripImagesRefusedByStamp<M extends Message>(rows: M[]): M[] {
  const claimed = new Set<number>()
  rows.forEach((row, at) => {
    if (mediaRefusalOf(row)?.blockTypes.includes('image') !== true) return
    for (let earlier = at - 1; earlier >= 0; earlier--) {
      if (claimed.has(earlier) || !holdsImage(rows[earlier]!)) continue
      claimed.add(earlier)
      return
    }
  })
  if (claimed.size === 0) return rows
  return rows.map((row, at) => (claimed.has(at) ? withImagesElided(row) : row))
}

function refusedTurnIds(rows: readonly Message[]): Set<string> {
  const refused = new Set<string>()
  for (const row of rows) {
    if (row.type === 'assistant' && !isSyntheticApiErrorMessage(row) && row.message.stop_reason === 'refusal') refused.add(row.message.id)
  }
  if (refused.size === 0) return refused
  for (const row of rows) {
    if (row.type !== 'assistant' || !Array.isArray(row.message.content)) continue
    if (row.message.content.some(block => block.type === 'tool_use')) refused.delete(row.message.id)
  }
  return refused
}

export function planApiConversation(
  messages: Message[],
  tools: Tools = [],
): ApiConversationPlan {
  const ordered = modelRelevantRows(messages)
  const stripTargets = stripTargetsAmong(ordered)
  const refused = refusedTurnIds(ordered)
  const kept: PlannedMessage[] = []
  for (const row of ordered) {
    if (row.type === 'progress' || isSyntheticApiErrorMessage(row)) continue
    if (row.type === 'system') {
      if (isSystemLocalCommandMessage(row)) kept.push(row)
      continue
    }
    if (row.type === 'assistant' && refused.has(row.message.id)) continue
    kept.push(row)
  }
  return { selected: foldBatchedRows(withoutOrphanCaveats(kept)), stripTargets, availableToolNames: new Set(tools.map(tool => tool.name)) }
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
export type RequestConversationPlan = ApiConversationPlan & {
  messages: (UserMessage | AssistantMessage)[]
}

function planFamilyConversation(messages: readonly Message[], tools: Tools): ApiConversationPlan {
  const refused = refusedTurnIds(messages)
  const kept: PlannedMessage[] = []
  for (const row of messages) {
    if (row.type === 'attachment' || isSystemLocalCommandMessage(row)) kept.push(row)
    if (row.type !== 'user' && row.type !== 'assistant') continue
    if (row.isVirtual || (row.type === 'assistant' && refused.has(row.message.id))) continue
    kept.push(row)
  }
  return { selected: withoutOrphanCaveats(kept), stripTargets: new Map(), availableToolNames: new Set(tools.map(tool => tool.name)) }
}

function wireAssistantOf(row: AssistantMessage, tools: Tools, searchOn: boolean): AssistantMessage {
  const content = storedBlocksOf(row.message.content).map(block => {
    if (block.type !== 'tool_use') return block
    const tool = tools.find(candidate => toolMatchesName(candidate, block.name))
    const name = tool === undefined ? block.name : tool.name
    const input = tool === undefined ? block.input : normalizeToolInputForAPI(tool, block.input as Record<string, unknown>)
    return searchOn ? { ...block, name, input } : { type: 'tool_use' as const, id: block.id, name, input }
  })
  return { ...row, message: { ...row.message, content: content as AssistantMessage['message']['content'] } }
}

function priorFragmentOf(rows: readonly (UserMessage | AssistantMessage)[], messageId: string): number {
  for (let at = rows.length - 1; at >= 0; at--) {
    const row = rows[at]!
    if (row.type === 'assistant') {
      if (row.message.id === messageId) return at
      continue
    }
    if (!isToolResultMessage(row)) return -1
  }
  return -1
}

function projectForAnthropic(plan: ApiConversationPlan, tools: Tools): (UserMessage | AssistantMessage)[] {
  const searchOn = isToolSearchEnabledOptimistic()
  const out: (UserMessage | AssistantMessage)[] = []
  const joinUser = (row: UserMessage, merge: (left: UserMessage, right: UserMessage) => UserMessage): void => {
    const before = out.at(-1)
    if (before?.type === 'user') out[out.length - 1] = merge(before, row)
    else out.push(row)
  }
  for (const row of plan.selected) {
    if (row.type === 'attachment') {
      for (const made of normalizeAttachmentForAPI(row.attachment)) joinUser(made, mergeUserMessagesAndToolResults)
      continue
    }
    if (row.type === 'system') {
      joinUser(createUserMessage({ content: row.content, uuid: row.uuid, timestamp: row.timestamp }), mergeUserMessages)
      continue
    }
    if (row.type === 'user') {
      const referenced = searchOn ? stripUnavailableToolReferencesFromUserMessage(row, plan.availableToolNames) : stripToolReferenceBlocksFromUserMessage(row)
      const stripped = applyStripTargets(referenced, plan.stripTargets)
      if (stripped !== null) joinUser(withToolReferenceTurnBoundary(stripped), mergeUserMessages)
      continue
    }
    const wired = wireAssistantOf(row, tools, searchOn)
    const at = priorFragmentOf(out, wired.message.id)
    const earlier = at === -1 ? undefined : out[at]
    if (earlier?.type === 'assistant') out[at] = mergeAssistantMessages(earlier, wired)
    else out.push(wired)
  }
  return out
}

function projectForFamily(plan: ApiConversationPlan): (UserMessage | AssistantMessage)[] {
  const out: (UserMessage | AssistantMessage)[] = []
  for (const row of plan.selected) {
    if (row.type === 'attachment') out.push(...normalizeAttachmentForAPI(row.attachment))
    else if (row.type === 'system') out.push(createUserMessage({ content: row.content, uuid: row.uuid, timestamp: row.timestamp }))
    else out.push(row)
  }
  return out
}

function pureKindOf(row: UserMessage): 'text' | 'tool_result' | null {
  const { content } = row.message
  if (typeof content === 'string') return 'text'
  if (content.length === 0) return null
  if (content.every(block => block.type === 'text')) return 'text'
  return content.every(block => block.type === 'tool_result') ? 'tool_result' : null
}

function holdsTurnCutText(row: UserMessage): boolean {
  const { content } = row.message
  if (typeof content === 'string') return isTurnCutText(content)
  return content.some(block => block.type === 'text' && isTurnCutText(block.text))
}

function coalesceAdjacentUsers(rows: (UserMessage | AssistantMessage)[]): (UserMessage | AssistantMessage)[] {
  const out: (UserMessage | AssistantMessage)[] = []
  for (const row of rows) {
    const before = out.at(-1)
    const kind = row.type === 'user' && before?.type === 'user' ? pureKindOf(row) : null
    if (row.type !== 'user' || before?.type !== 'user' || kind === null || kind !== pureKindOf(before)) {
      out.push(row)
      continue
    }
    if (kind === 'tool_result' || holdsTurnCutText(before) || holdsTurnCutText(row)) out[out.length - 1] = mergeUserMessages(before, row)
    else out.push(row)
  }
  return out.length === rows.length ? rows : out
}

export function requestConversationPlan(
  messages: readonly Message[],
  tools: Tools = [],
  geometry: 'anthropic' | 'family' = 'anthropic',
): RequestConversationPlan {
  const anthropic = geometry === 'anthropic'
  const plan = anthropic ? planApiConversation([...messages], tools) : planFamilyConversation(messages, tools)
  const prepared = anthropic
    ? finishApiContent(projectForAnthropic(plan, tools))
    : pairConversationMessages(stripImagesRefusedByStamp(projectForFamily(plan)).filter(row => !isSyntheticApiErrorMessage(row)), 'split')
  return { ...plan, selected: plan.selected.filter(row => !isSyntheticApiErrorMessage(row)), messages: coalesceAdjacentUsers(prepared) }
}

function finishApiContent(messages: (UserMessage | AssistantMessage)[]): (UserMessage | AssistantMessage)[] {
  let rows = messages
  for (const stage of [dropEmptyTextBlocks, filterOrphanedThinkingOnlyMessages, filterTrailingThinkingFromLastAssistant, filterWhitespaceOnlyAssistantMessages, ensureNonEmptyAssistantContent, sanitizeErrorToolResultContent]) {
    rows = stage(rows) as (UserMessage | AssistantMessage)[]
  }
  validateImagesForAPI(rows)
  return rows
}
