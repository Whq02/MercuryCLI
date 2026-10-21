import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/constants.js'
import type { Message } from '../types/message.js'
import { hasSuccessfulToolCall } from '../utils/messages.js'
import { isToolResultMessage } from '../utils/messages/merge.js'
import { disengageTurnGuard, engageTurnGuard } from './guards.js'

const STRUCTURED_OUTPUT_GUARD_ID = 'structured-output'

function currentTurnOf(messages: Message[]): Message[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type === 'user' && message.isMeta !== true && !isToolResultMessage(message)) return messages.slice(index)
  }
  return messages
}

export function registerStructuredOutputGuard(key: string): void {
  engageTurnGuard(key, {
    id: STRUCTURED_OUTPUT_GUARD_ID,
    timeoutMs: 5000,
    judge: ({ messages }) => (hasSuccessfulToolCall(currentTurnOf(messages), SYNTHETIC_OUTPUT_TOOL_NAME) ? { hold: false } : { hold: true, words: `The ${SYNTHETIC_OUTPUT_TOOL_NAME} tool must be called to complete this request. Call it now.` }),
  })
}

export function releaseStructuredOutputGuard(key: string): void {
  disengageTurnGuard(key, STRUCTURED_OUTPUT_GUARD_ID)
}
