import type { CanUseToolFn } from '../../../tools/kit/tool.js'
import type { Message, UserMessage } from '../../message-shapes/message.js'
import { boundHookContext } from '../../../integrations/event-hooks/contextBound.js'
import { createUserMessage, isFoldBoundaryMessage } from '../../messages/messages.js'
import { getPromptTooLongTokenGap } from '../../requests/apiErrorRows.js'
import { overflowGapTokens, overflowSignalOf } from '../../requests/overflowSignal.js'
import { groupMessagesByApiRound } from '../groupByApiRound.js'
import { estimateMessageTokens } from '../pruneToolResults.js'
import { PTL_TRUNCATION_MARKER, LEGACY_PTL_TRUNCATION_MARKER } from './foldLimits.js'

export function boundedHookInstructions(hookInstructions: string | undefined): string | undefined {
  const words = hookInstructions?.trim() ?? ''
  return words === '' ? undefined : boundHookContext(words, 'compaction-before-instructions').text
}

export function mergeHookInstructions(
  userInstructions?: string,
  hookInstructions?: string,
): string | undefined {
  const user = userInstructions?.trim() ?? ''
  const hook = boundedHookInstructions(hookInstructions)
  if (user !== '' && hook !== undefined) return `${user}\n\n${hook}`
  if (user !== '') return user
  return hook
}

export function isPtlMarkerMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const user = message
  return (
    user.isMeta === true &&
    (user.message.content === PTL_TRUNCATION_MARKER || user.message.content === LEGACY_PTL_TRUNCATION_MARKER)
  )
}

export function isFoldCapsuleMessage(message: Message): boolean {
  return (
    isFoldBoundaryMessage(message) ||
    (message.type === 'user' && message.isCompactSummary === true)
  )
}

export function truncateHeadForPTLRetry(messages: Message[], ptlResponse: Message): Message[] | null {
  const input = messages.filter(message => !isPtlMarkerMessage(message))
  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null

  const signal = overflowSignalOf(ptlResponse)
  const gap = getPromptTooLongTokenGap(ptlResponse) ?? (signal !== null ? overflowGapTokens(signal) : undefined)

  let dropCount: number
  if (gap !== undefined) {
    dropCount = 0
    let freed = 0
    while (dropCount < groups.length - 1 && freed < gap) {
      const nonCapsule = groups[dropCount]!.filter(message => !isFoldCapsuleMessage(message))
      freed += estimateMessageTokens(nonCapsule)
      dropCount++
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  }

  dropCount = Math.min(dropCount, groups.length - 1)
  while (
    dropCount < groups.length - 1 &&
    groups.slice(0, dropCount).flat().every(isFoldCapsuleMessage)
  ) {
    dropCount++
  }

  const dropped = groups.slice(0, dropCount).flat()
  if (dropCount === 0 || dropped.every(isFoldCapsuleMessage)) {
    return null
  }

  const retained = dropped.filter(isFoldCapsuleMessage)
  const surviving = groups.slice(dropCount).flat()
  if (surviving[0]?.type === 'assistant') {
    const marker = createUserMessage({ content: PTL_TRUNCATION_MARKER, isMeta: true })
    return [...retained, marker, ...surviving]
  }
  return [...retained, ...surviving]
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

export function createFoldCanUseTool(): CanUseToolFn {
  return async () => ({
    behavior: 'deny',
    message: 'Tool use is not allowed during compaction.',
    decisionReason: {
      type: 'other',
      reason: 'The compaction agent should only produce a text summary.',
    },
  })
}
