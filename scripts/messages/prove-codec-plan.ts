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
const openai = await import('../../src/services/providers/openai/responsesBridge.ts')
const bridge = messages.map(message => ({
  role: message.type,
  content: message.message.content,
  ...(message.type === 'assistant' ? { turnId: message.message.id } : {}),
}))
assert.equal(JSON.stringify(openai.encodeOpenaiPlan(plan)), JSON.stringify(openai.mapMessagesToOpenaiInput(bridge)))
const replay = { provider: 'openai', items: [{ type: 'reasoning', id: 'fixture-reasoning', summary: [], encrypted_content: 'fixture-private-replay' }, { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'fixture settled answer' }] }] }
const assistant = messages.find(message => message.type === 'assistant')!
const replayPlan = requestPlanOf([{ ...assistant, message: { ...assistant.message, model: 'fixture-openai-model' }, apexProviderTurn: replay } as never])
assert.equal(JSON.stringify(openai.encodeOpenaiPlan(replayPlan, { model: 'fixture-openai-model' })), JSON.stringify(openai.decodeOpenaiTurnRecord(replay)!.items))
assert.equal(JSON.stringify(openai.encodeOpenaiPlan(replayPlan)).includes('fixture-private-replay'), false)
assert.equal(JSON.stringify(openai.encodeOpenaiPlan(replayPlan, { model: 'fixture-other-model' })).includes('fixture-private-replay'), false)
console.log('PASS: the Responses plan codec preserves item order, text registers and private replay without re-derivation')
const gemini = await import('../../src/services/providers/gemini/geminiCodec.ts')
const chat = await import('../../src/services/providers/zai/zaiCodec.ts')
const chatRows = chat.mapMessagesToZai(undefined, bridge)
const nativeRequest = { model: 'fixture-model', messages: chatRows }
assert.equal(JSON.stringify(gemini.encodeGeminiPlan(plan, { model: 'fixture-model' })), JSON.stringify(gemini.buildGeminiRequest(nativeRequest, messages)))
console.log('PASS: the Gemini plan codec preserves native parts, tool responses and signature replay context')
for (const keepReasoningHistory of [false, true]) {
  assert.equal(JSON.stringify(chat.encodeChatPlan(plan, { keepReasoningHistory })), JSON.stringify(chat.mapMessagesToZai(undefined, bridge, { keepReasoningHistory })))
}
console.log('PASS: the compatible-chat plan codec retains each selected reasoning-history and image spelling')
const local = await import('../../src/services/providers/local/ollamaChatTransport.ts')
assert.equal(JSON.stringify(local.encodeLocalPlan(plan, { model: 'fixture-model' }, { numCtx: 8192 })), JSON.stringify(local.ollamaChatBody(nativeRequest, { numCtx: 8192 })))
console.log('PASS: the local plan codec retains Ollama text, images, tool names and request options')
