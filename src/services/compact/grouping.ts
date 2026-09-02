import type { AssistantMessage, Message } from '../../types/message.js'

/**
 * Splits a message list into groups, one per API round-trip.
 *
 * A boundary fires when an assistant message's message id differs from the
 * last-seen assistant id AND the current group is non-empty; that message
 * starts the new group. Every other message appends to the current group. The
 * last-seen assistant id updates on every assistant message.
 *
 * Why the id and only the id: streaming chunks of one response share an id,
 * and the normaliser yields one message per content block while the
 * transcript records yield order rather than concatenation order — so tool
 * results can sit between same-id chunks, and the id check correctly keeps
 * [tool_use(id=X), result, tool_use(id=X)] in one group.
 *
 * A second gate on "are all tool uses resolved yet" must be resisted: on a
 * well-formed conversation it never changes the answer, and on a malformed
 * one (a dangling tool use from a partial-batch resume or output truncation)
 * it would hold the gate closed forever, collapsing every later round into a
 * single group. The boundary fires instead; the pairing repair the
 * summariser fork runs at send time deals with the dangling tool use.
 *
 * This grouping deliberately replaced human-turn grouping so single-prompt
 * agentic sessions (SDK, remote, evaluation callers) can still be split.
 */
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
