import type { CanUseToolFn } from '../../../Tool.js'
import type { Message, UserMessage } from '../../../types/message.js'
import { boundHookContext } from '../../../utils/hooks/contextBound.js'
import { createUserMessage, isCompactBoundaryMessage } from '../../messages.js'
import { getPromptTooLongTokenGap } from '../../api/errors.js'
import { overflowGapTokens, overflowSignalOf } from '../../api/overflowSignal.js'
import { groupMessagesByApiRound } from '../grouping.js'
import { estimateMessageTokens } from '../microCompact.js'
import { PTL_TRUNCATION_MARKER, LEGACY_PTL_TRUNCATION_MARKER } from './limits.js'
import { notBuilt } from '../../../pi/holes.js'

export function boundedHookInstructions(hookInstructions: string | undefined): string | undefined {
  const words = hookInstructions?.trim() ?? ''
  return words === '' ? undefined : boundHookContext(words, 'compaction-before-instructions').text
}

export function mergeHookInstructions(
  userInstructions?: string,
  hookInstructions?: string,
): string | undefined {
  return notBuilt('src/services/compact/compact/input.ts:16')
}

export function isPtlMarkerMessage(message: Message): boolean {
  return notBuilt('src/services/compact/compact/input.ts:28')
}

export function isCompactCapsuleMessage(message: Message): boolean {
  return notBuilt('src/services/compact/compact/input.ts:37')
}

export function truncateHeadForPTLRetry(messages: Message[], ptlResponse: Message): Message[] | null {
  return notBuilt('src/services/compact/compact/input.ts:44')
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
  return notBuilt('src/services/compact/compact/input.ts:114')
}
