import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/constants.js'
import { hasSuccessfulToolCall } from '../utils/messages.js'
import { engageTurnGuard } from './guards.js'

export const STRUCTURED_OUTPUT_GUARD_ID = 'structured-output'

export function registerStructuredOutputGuard(key: string): void {
  engageTurnGuard(key, {
    id: STRUCTURED_OUTPUT_GUARD_ID,
    timeoutMs: 5000,
    judge: ({ messages }) => (hasSuccessfulToolCall(messages, SYNTHETIC_OUTPUT_TOOL_NAME) ? { hold: false } : { hold: true, words: `The ${SYNTHETIC_OUTPUT_TOOL_NAME} tool must be called to complete this request. Call it now.` }),
  })
}
