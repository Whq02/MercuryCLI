import type { AssistantMessage } from '../../types/message.js'

export type EmptyReplyRoute = 'openai' | 'zai'

type MarkedAssistantMessage = AssistantMessage & { providerEmptyReply?: true }

export function emptyReplyNote(route: EmptyReplyRoute): string {
  return `[${route}] the provider returned an empty reply — the turn was cut, not finished.`
}

export function emptyReplyNoticeLine(action: string): string {
  return `The provider returned an empty reply — ${action}`
}

export function markEmptyReply(message: AssistantMessage): void {
  ;(message as MarkedAssistantMessage).providerEmptyReply = true
}

export function isEmptyReplyMessage(message: AssistantMessage): boolean {
  return (message as MarkedAssistantMessage).providerEmptyReply === true
}
