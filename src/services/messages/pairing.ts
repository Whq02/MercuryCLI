import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import { requestConversationPlan } from './apiPlan.js'
export { ensureToolResultPairing, foldSplitTurnsForWire, orderToolResultsByUse, pairConversationMessages } from '../../utils/messages/resultPairing.js'

export function healWalkableForWire(
  messages: readonly { type: string }[],
): (UserMessage | AssistantMessage)[] {
  return requestConversationPlan(messages as readonly Message[], [], 'family').messages
}

export function isUnsignedThinkingBlock(b: { type?: string }): boolean {
  if (b.type !== 'thinking') return false
  const signature = (b as { signature?: unknown }).signature
  return !(typeof signature === 'string' && signature.length > 0)
}

export function stripUnsignedThinkingBlocks(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  let changed = false
  const rows = messages.map(row => {
    if (row.type !== 'assistant') return row
    const before = row.message.content
    const kept = before.filter(block => !isUnsignedThinkingBlock(block))
    const phased = kept.some(block => block.type === 'text' && 'phase' in block)
    if (kept.length === before.length && !phased) return row
    const content = kept.map(block => {
      if (block.type !== 'text' || !('phase' in block)) return block
      const { phase: _phase, ...unphased } = block
      return unphased
    })
    if (content.length === 0) content.push({ type: 'text', text: '[reasoning from another model provider — not transferable]', citations: [] })
    changed = true
    return { ...row, message: { ...row.message, content } }
  })
  return changed ? rows : messages
}
