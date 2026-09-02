import type {
  AssistantMessage,
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from '../types/message.js'


export function tagMessagesWithToolUseID<
  M extends UserMessage | AttachmentMessage | SystemMessage,
>(messages: M[], toolUseID?: string): M[] {
  if (!toolUseID) return messages
  return messages.map(message =>
    message.type === 'user' ? { ...message, sourceToolUseID: toolUseID } : message,
  )
}

export function getToolUseIDFromParentMessage(
  parentMessage: AssistantMessage,
  toolName: string,
): string | undefined {
  const content = parentMessage.message.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block.type === 'tool_use' && block.name === toolName) return block.id
  }
  return undefined
}
