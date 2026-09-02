import {
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'

export type ConversationSignalMessage = {
  readonly type: string
  readonly isMeta?: boolean | undefined
  readonly message?: { readonly content?: unknown } | undefined
}

const NOISE_MARKS = [
  `<${COMMAND_NAME_TAG}>`,
  `<${COMMAND_MESSAGE_TAG}>`,
  `<${LOCAL_COMMAND_STDOUT_TAG}`,
  `<${LOCAL_COMMAND_STDERR_TAG}`,
  `<${LOCAL_COMMAND_CAVEAT_TAG}>`,
] as const

const NO_RESPONSE_SENTINEL = 'No response requested.'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (
      block != null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      out += (out ? '\n' : '') + (block as { text: string }).text
    }
  }
  return out
}

export function isTranscriptFurnitureMessage(
  msg: ConversationSignalMessage,
): boolean {
  if (msg.type === 'system') return true
  if (msg.type === 'assistant') {
    const content = msg.message?.content
    if (typeof content === 'string') return content === NO_RESPONSE_SENTINEL
    if (Array.isArray(content) && content.length === 1) {
      const b = content[0] as { type?: unknown; text?: unknown }
      return b?.type === 'text' && b.text === NO_RESPONSE_SENTINEL
    }
    return false
  }
  if (msg.type !== 'user') return false
  if (msg.isMeta === true) return true
  const text = textOf(msg.message?.content)
  if (text.length === 0) return false
  return NOISE_MARKS.some(mark => text.includes(mark))
}

export function hasRealConversation(
  messages: readonly ConversationSignalMessage[],
): boolean {
  for (const m of messages) if (!isTranscriptFurnitureMessage(m)) return true
  return false
}
