// The ONE operator-turn predicate — what the operator SENT, nothing else.
// The frame's ⤳N counter and the resume recap's "N turns" both count with it,
// so the two surfaces can never disagree.
//
// A user-typed message is a turn. A slash command's transcript echo
// (`<command-message>…` / `<command-name>…` wrapped), a local command's
// captured stdout/stderr, a tool result riding a user-role message, a
// compact summary, a transcript-only echo, and every meta message are not —
// the band counted the first two, so two slash commands on a fresh session
// read ⤳2 with no model exchange yet.
import {
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import type { Message } from '../../types/message.js'

const COMMAND_ECHO_PREFIXES = [
  `<${COMMAND_MESSAGE_TAG}>`,
  `<${COMMAND_NAME_TAG}>`,
  `<${LOCAL_COMMAND_STDOUT_TAG}>`,
  `<${LOCAL_COMMAND_STDERR_TAG}>`,
]

function isCommandEcho(text: string): boolean {
  const s = text.trimStart()
  return COMMAND_ECHO_PREFIXES.some(prefix => s.startsWith(prefix))
}

/** True for a user-role message the operator typed as a prompt. */
export function isOperatorTurn(message: Message): boolean {
  if (message.type !== 'user') return false
  if ('isMeta' in message && message.isMeta) return false
  const flags = message as { isCompactSummary?: boolean; isVisibleInTranscriptOnly?: boolean }
  if (flags.isCompactSummary === true || flags.isVisibleInTranscriptOnly === true) return false
  const content = message.message.content
  if (typeof content === 'string') return content.trim() !== '' && !isCommandEcho(content)
  let sawText = false
  for (const block of content) {
    if (block.type === 'tool_result') return false
    if (block.type === 'text') {
      if (isCommandEcho(block.text)) return false
      if (block.text.trim() !== '') sawText = true
    }
  }
  return sawText
}

export function countOperatorTurns(messages: readonly Message[]): number {
  let turns = 0
  for (const message of messages) if (isOperatorTurn(message)) turns++
  return turns
}
