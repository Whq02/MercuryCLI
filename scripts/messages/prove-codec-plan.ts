import { strict as assert } from 'node:assert'
import { DIALECT_CONVERSATION } from './dialectFixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { requestPlanOf } = await import('../../src/rows/request.ts')
const { normalizeMessagesForAPI } = await import('../../src/utils/messages/apiView.ts')
const anthropic = await import('../../src/services/providers/anthropic/messageParams.ts')
const messages = normalizeMessagesForAPI(DIALECT_CONVERSATION)
const plan = requestPlanOf(messages)
const before = JSON.stringify(messages)
for (const cacheTurn of [-1, 0, messages.length - 1]) {
  const legacy = messages.map((message, index) => message.type === 'user'
    ? anthropic.userMessageToMessageParam(message, index === cacheTurn, true)
    : anthropic.assistantMessageToMessageParam(message, index === cacheTurn, true))
  assert.equal(JSON.stringify(anthropic.encodeAnthropicPlan(plan, true, cacheTurn)), JSON.stringify(legacy))
}
assert.equal(JSON.stringify(messages), before)
console.log('PASS: the Anthropic plan codec preserves the legacy wire spelling and cache-marker placement')
