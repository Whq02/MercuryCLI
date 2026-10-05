import { strict as assert } from 'node:assert'
import { DIALECT_CONVERSATION, VIRTUAL_ROW, FIXTURE_TOOLS } from './dialectFixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { requestConversationPlan } = await import('../../src/utils/messages/apiPlan.ts')
const { normalizeMessagesForAPI } = await import('../../src/utils/messages/apiView.ts')
const { healWalkableForWire } = await import('../../src/utils/messages/pairing.ts')
const history = [...DIALECT_CONVERSATION.slice(0, 2), VIRTUAL_ROW as never, ...DIALECT_CONVERSATION.slice(2)]
for (const geometry of ['anthropic', 'family'] as const) {
  const plan = requestConversationPlan(history, FIXTURE_TOOLS as never, geometry)
  const legacy = geometry === 'anthropic' ? normalizeMessagesForAPI(history, FIXTURE_TOOLS as never) : healWalkableForWire(history)
  assert.deepEqual(plan.messages, legacy)
  assert.equal(plan.messages.some(message => message.isVirtual), false)
  assert.equal('request' in plan, false)
}
assert.equal(history[2], VIRTUAL_ROW)
console.log('PASS: both request geometries consume one row-backed plan without changing transcript identity or replay facts')
