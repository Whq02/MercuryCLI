import type { Message, UserMessage } from '../../engine/message-shapes/message.js'

export function isHumanTurn(m: Message): m is UserMessage {
  return m.type === 'user' && !m.isMeta && m.toolUseResult === undefined
}
