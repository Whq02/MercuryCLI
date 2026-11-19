import type { CanUseToolFn } from '../../../Tool.js'
import type { Message, UserMessage } from '../../../types/message.js'
import { boundHookContext } from '../../../utils/hooks/contextBound.js'
import { createUserMessage, isCompactBoundaryMessage } from '../../../utils/messages.js'
import { getPromptTooLongTokenGap } from '../../api/errors.js'
import { overflowGapTokens, overflowSignalOf } from '../../api/overflowSignal.js'
import { groupMessagesByApiRound } from '../grouping.js'
import { estimateMessageTokens } from '../microCompact.js'
import { PTL_TRUNCATION_MARKER, LEGACY_PTL_TRUNCATION_MARKER } from './limits.js'

export function boundedHookInstructions(hookInstructions: string | undefined): string | undefined {
  const words = hookInstructions?.trim() ?? ''
  return words === '' ? undefined : boundHookContext(words, 'compaction-before-instructions').text
}

export function mergeHookInstructions(
  userInstructions?: string,
  hookInstructions?: string,
): string | undefined {
  const user = userInstructions?.trim() ?? ''
  const hook = boundedHookInstructions(hookInstructions) ?? ''
  if (user !== '' && hook !== '') return `${user}\n\n${hook}`
  if (user !== '') return user
  if (hook !== '') return hook
  return undefined
}

export function isPtlMarkerMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const user = message as UserMessage
  return (
    user.isMeta === true &&
    (user.message.content === PTL_TRUNCATION_MARKER || user.message.content === LEGACY_PTL_TRUNCATION_MARKER)
  )
}

export function isCompactCapsuleMessage(message: Message): boolean {
  return (
    isCompactBoundaryMessage(message) ||
    (message.type === 'user' && (message as UserMessage).isCompactSummary === true)
  )
}

export function truncateHeadForPTLRetry(messages: Message[], ptlResponse: Message): Message[] | null {
  const input = messages.filter(message => !isPtlMarkerMessage(message))
  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null

  const shedTokensOf = (group: Message[]): number =>
    estimateMessageTokens(group.filter(message => !isCompactCapsuleMessage(message)))

  const signal = overflowSignalOf(ptlResponse)
  const gap = getPromptTooLongTokenGap(ptlResponse) ?? (signal !== null ? overflowGapTokens(signal) : undefined)
  let dropCount: number
  if (gap !== undefined) {
    dropCount = 0
    let freed = 0
    while (dropCount < groups.length && freed < gap) {
      freed += shedTokensOf(groups[dropCount] as Message[])
      dropCount++
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  }
  dropCount = Math.min(dropCount, groups.length - 1)
  while (dropCount > 0 && dropCount < groups.length - 1 && groups.slice(0, dropCount).flat().every(isCompactCapsuleMessage)) {
    dropCount++
  }
  if (dropCount <= 0) return null

  const dropped = groups.slice(0, dropCount).flat()
  const retained = dropped.filter(isCompactCapsuleMessage)
  if (retained.length === dropped.length) return null

  const survivors = groups.slice(dropCount).flat()
  if (survivors.length > 0 && survivors[0]?.type === 'assistant') {
    return [...retained, createUserMessage({ content: PTL_TRUNCATION_MARKER, isMeta: true }), ...survivors]
  }
  return [...retained, ...survivors]
}

export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.type !== 'user') return message
    const content = (message as UserMessage).message.content
    if (!Array.isArray(content)) return message
    let touched = false
    const mapBlock = (block: unknown): unknown => {
      const record = block as { type?: string; content?: unknown }
      if (record.type === 'image') {
        touched = true
        return { type: 'text', text: '[image]' }
      }
      if (record.type === 'document') {
        touched = true
        return { type: 'text', text: '[document]' }
      }
      if (record.type === 'tool_result' && Array.isArray(record.content)) {
        const inner = record.content.map(mapBlock)
        return touched ? { ...record, content: inner } : block
      }
      return block
    }
    const rebuilt = content.map(mapBlock)
    if (!touched) return message
    return { ...message, message: { ...(message as UserMessage).message, content: rebuilt } } as Message
  })
}

export function stripReinjectedAttachments(messages: Message[]): Message[] {
  return messages
}

export function createCompactCanUseTool(): CanUseToolFn {
  return async () => ({
    behavior: 'deny',
    message: 'Tool use is not allowed during compaction.',
    decisionReason: {
      type: 'other',
      reason: 'The compaction agent should only produce a text summary.',
    },
  })
}
