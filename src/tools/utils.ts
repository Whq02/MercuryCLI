import type { AssistantMessage, Message } from '../types/message.js'
import { notBuilt } from '../pi/holes.js'


export function tagMessagesWithToolUseID<M extends Message>(
  messages: M[],
  toolUseID?: string,
): M[] {
  return notBuilt('src/tools/utils.ts:7')
}

export function getToolUseIDFromParentMessage(
  parentMessage: AssistantMessage,
  toolName: string,
): string | undefined {
  return notBuilt('src/tools/utils.ts:17')
}
