import { NO_CONTENT_MESSAGE } from '../../message-shapes/noContentMessage.js'
import type { AssistantMessage, Message } from '../../message-shapes/message.js'

export function lastTextBlockOf(message: AssistantMessage): string {
  const content = message.message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (let index = content.length - 1; index >= 0; index--) {
    const block = content[index] as { type?: string; text?: string }
    if (block.type === 'text' && typeof block.text === 'string') return block.text === NO_CONTENT_MESSAGE ? '' : block.text
  }
  return ''
}

export function latestAnswerOf(turnMessages: Message[]): () => string {
  const latestAnswer = (): string => {
    for (let i = turnMessages.length - 1; i >= 0; i--) {
      const message = turnMessages[i]!
      if (message.type !== 'assistant') continue
      if ((message as { isApiErrorMessage?: boolean }).isApiErrorMessage === true) continue
      const answer = lastTextBlockOf(message as AssistantMessage)
      if (answer !== '') return answer
    }
    return ''
  }
  return latestAnswer
}
