import type { Message } from '../message-shapes/message.js'

export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  let currentGroup: Message[] = []
  let lastAssistantId: string | undefined

  for (const message of messages) {
    if (message.type === 'assistant') {
      const msgId = message.message.id
      if (msgId !== lastAssistantId && currentGroup.length > 0) {
        groups.push(currentGroup)
        currentGroup = []
      }
      lastAssistantId = msgId
    }
    currentGroup.push(message)
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup)
  }

  return groups
}
