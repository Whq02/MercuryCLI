import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import { requestConversationPlan } from './apiPlan.js'
import { notBuilt } from '../../pi/holes.js'
export { ensureToolResultPairing, foldSplitTurnsForWire, orderToolResultsByUse, pairConversationMessages } from '../../utils/messages/resultPairing.js'

export function healWalkableForWire(
  messages: readonly { type: string }[],
): (UserMessage | AssistantMessage)[] {
  return notBuilt('src/services/messages/pairing.ts:9')
}

export function isUnsignedThinkingBlock(b: { type?: string }): boolean {
  if (b.type !== 'thinking') return false
  const signature = (b as { signature?: unknown }).signature
  return !(typeof signature === 'string' && signature.length > 0)
}

export function stripUnsignedThinkingBlocks(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  return notBuilt('src/services/messages/pairing.ts:21')
}
