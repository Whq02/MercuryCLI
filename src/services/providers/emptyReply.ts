import type { AssistantMessage } from '../../types/message.js'

type EmptyReplyRoute = 'openai' | 'zai'

export type EmptyReplyKind = 'silence' | 'cap' | 'empty'

type MarkedAssistantMessage = AssistantMessage & { providerEmptyReply?: true; providerEmptyReplyKind?: EmptyReplyKind; providerEmptyReplyNote?: string }

export function emptyReplyNote(route: EmptyReplyRoute, kind: EmptyReplyKind = 'empty', reasoningTokens?: number): string {
  if (kind === 'silence') {
    const detail =
      route === 'zai'
        ? 'no words and no reasoning came back'
        : 'the model reasoned and returned no words'
    return `[${route}] the provider finished this response with nothing said — ${detail}; the turn ends here, not cut.`
  }
  if (kind === 'cap') {
    const spent =
      reasoningTokens === undefined
        ? 'a reasoning token count the provider did not state'
        : `${reasoningTokens} reasoning tokens spent by the provider's count`
    return `[${route}] the provider stopped this response at its output cap with nothing said — ${spent}; the turn was cut at the cap, not finished.`
  }
  return `[${route}] the provider returned an empty reply — the turn was cut, not finished.`
}

export function emptyReplyChatText(kind: EmptyReplyKind, note: string): string {
  return kind === 'silence' ? '' : note
}

export function emptyReplyNoticeLine(action: string): string {
  return `The provider returned an empty reply — ${action}`
}

export function emptyReplyEndedLine(retries: number): string {
  return emptyReplyNoticeLine(`the model was already asked for its answer ${retries === 1 ? 'once' : `${retries} times`}; the turn ends here`)
}

export function markEmptyReply(message: AssistantMessage, kind: EmptyReplyKind = 'empty', note?: string): void {
  const marked = message as MarkedAssistantMessage
  marked.providerEmptyReply = true
  marked.providerEmptyReplyKind = kind
  if (note !== undefined) marked.providerEmptyReplyNote = note
}

export function emptyReplyKindOf(message: AssistantMessage): EmptyReplyKind | undefined {
  const marked = message as MarkedAssistantMessage
  if (marked.providerEmptyReply !== true) return undefined
  return marked.providerEmptyReplyKind ?? 'empty'
}

export function emptyReplyNoteOf(message: AssistantMessage): string | undefined {
  const marked = message as MarkedAssistantMessage
  return marked.providerEmptyReply === true ? marked.providerEmptyReplyNote : undefined
}
