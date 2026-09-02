import type { Message, UserMessage } from '../types/message.js'

// A tool_result rides type:'user' exactly like a real human turn; the
// separator is the optional toolUseResult field. Counting human turns off
// the type alone has caused repeated miscounts — route through this predicate.
export function isHumanTurn(m: Message): m is UserMessage {
  return m.type === 'user' && !m.isMeta && m.toolUseResult === undefined
}
