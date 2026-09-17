import type { AssistantMessage } from '../../types/message.js'

export type EmptyReplyRoute = 'openai' | 'zai'

export type EmptyReplyKind = 'silence' | 'cap' | 'empty'

type MarkedAssistantMessage = AssistantMessage & { providerEmptyReply?: true; providerEmptyReplyKind?: EmptyReplyKind }

export function emptyReplyNote(route: EmptyReplyRoute, kind: EmptyReplyKind = 'empty', reasoningTokens?: number): string {
  if (kind === 'silence') {
    return `[${route}] the provider finished this response with nothing said — the model reasoned and returned no words; the turn ends here, not cut.`
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

export function emptyReplyNoticeLine(action: string): string {
  return `The provider returned an empty reply — ${action}`
}

export function markEmptyReply(message: AssistantMessage, kind: EmptyReplyKind = 'empty'): void {
  const marked = message as MarkedAssistantMessage
  marked.providerEmptyReply = true
  marked.providerEmptyReplyKind = kind
}

export function isEmptyReplyMessage(message: AssistantMessage): boolean {
  return (message as MarkedAssistantMessage).providerEmptyReply === true
}

export function emptyReplyKindOf(message: AssistantMessage): EmptyReplyKind | undefined {
  const marked = message as MarkedAssistantMessage
  if (marked.providerEmptyReply !== true) return undefined
  return marked.providerEmptyReplyKind ?? 'empty'
}
