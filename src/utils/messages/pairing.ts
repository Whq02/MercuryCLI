import '../../rows/content.js'
import '../../bootstrap/state.js'
import '../../constants/messages.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import '../log.js'
import { requestConversationPlan } from './apiPlan.js'
import './normalize.js'
import './factories.js'
import './rejectionText.js'
export { ensureToolResultPairing, foldSplitTurnsForWire, orderToolResultsByUse, pairConversationMessages } from './resultPairing.js'

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
  const result = messages.map(msg => {
    if (msg.type !== 'assistant') return msg
    const content = msg.message.content
    const filtered = content.filter(b => !isUnsignedThinkingBlock(b))
    const labelled = filtered.some(b => b.type === 'text' && 'phase' in b)
    if (filtered.length === content.length && !labelled) return msg
    changed = true
    const projected = labelled
      ? filtered.map(b => {
          if (b.type !== 'text' || !('phase' in b)) return b
          const { phase: _phase, ...unlabelled } = b
          return unlabelled
        })
      : filtered
    if (projected.length === 0) {
      projected.push({
        type: 'text' as const,
        text: '[reasoning from another model provider — not transferable]',
        citations: [],
      })
    }
    return { ...msg, message: { ...msg.message, content: projected } }
  })
  return changed ? result : messages
}
