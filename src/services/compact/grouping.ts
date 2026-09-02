import type { AssistantMessage, Message } from '../../types/message.js'

export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  let current: Message[] = []
  let lastAssistantId: string | undefined

  for (const message of messages) {
    if (message.type === 'assistant') {
      const id = (message as AssistantMessage).message.id
      if (id !== lastAssistantId && current.length > 0) {
        groups.push(current)
        current = []
      }
      lastAssistantId = id
    }
    current.push(message)
  }
  if (current.length > 0) groups.push(current)
  return groups
}
