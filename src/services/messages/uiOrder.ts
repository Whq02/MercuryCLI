import type { NormalizedAssistantMessage } from '../../types/message.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type DisplayMessage =
  Unbuilt

export function reorderMessagesInUI(
  messages: DisplayMessage[],
  syntheticStreamingToolUseMessages: NormalizedAssistantMessage[],
): DisplayMessage[] {
  return notBuilt('src/services/messages/uiOrder.ts:60')
}
