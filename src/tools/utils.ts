import type {
  AssistantMessage,
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from '../types/message.js'

/**
 * Two small message helpers shared by the tool layer: tag transient
 * messages with their originating tool-use id, and find a tool-use id in a
 * parent assistant message.
 */

/**
 * Tag every user message with the given tool-use id as its source, so it
 * stays transient until that tool resolves (otherwise the "is running"
 * message would duplicate in the UI). Attachment and system messages pass
 * through unchanged; no id returns the list unchanged.
 */
export function tagMessagesWithToolUseID<
  M extends UserMessage | AttachmentMessage | SystemMessage,
>(messages: M[], toolUseID?: string): M[] {
  if (!toolUseID) return messages
  return messages.map(message =>
    message.type === 'user' ? { ...message, sourceToolUseID: toolUseID } : message,
  )
}

/**
 * The id of the first tool_use block in the parent assistant message whose
 * tool name matches, else undefined.
 */
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
