import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DIALECT_CONVERSATION, TWO_MODEL_COMPACTION, FIXTURE_TOOLS, STRUCTURED_OUTPUT_ASK, canonicalJson } from './dialectFixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const recording = process.argv[2] === '--record'
const root = resolve(recording ? process.argv[3]! : new URL('../..', import.meta.url).pathname)
const source = async (path: string) => import(`${root}/src/${path}.ts`)
const { enableConfigs } = await source('utils/config')
enableConfigs()
const bootstrap = await source('bootstrap/state')
bootstrap.setIsInteractive(false)
const helpers = await source('utils/messages')
const filters = await source('utils/messages/apiFilters')
const params = await source('services/providers/anthropic/messageParams')
const openai = await source('services/providers/openai/responsesBridge')
const chat = await source('services/providers/zai/zaiCodec')
const gemini = await source('services/providers/gemini/geminiCodec')
const local = await source('services/providers/local/ollamaChatTransport')
const tools = FIXTURE_TOOLS.map((tool: any) => ({ name: tool.name, description: tool.description, input_schema: tool.inputJSONSchema }))
const bridge = (messages: any[]) => helpers.healWalkableForWire(messages).map((message: any) => message.type === 'user'
  ? params.userMessageToMessageParam(message, false, false)
  : { ...params.assistantMessageToMessageParam(message, false, false), turnId: message.message.id })
const bodies: Record<string, unknown> = {}
for (const [name, messages] of [['conversation', DIALECT_CONVERSATION], ['two-model', TWO_MODEL_COMPACTION]] as const) {
  let rows = helpers.normalizeMessagesForAPI(messages, FIXTURE_TOOLS)
  rows = helpers.orderToolResultsByUse(helpers.ensureToolResultPairing(rows))
  rows = helpers.stripUnsignedThinkingBlocks(rows)
  rows = filters.stripThinkingFromOtherModels(rows, 'claude-sonnet-5', (a: string, b: string) => a === b)
  bodies[`anthropic-${name}`] = {
    system: 'You are the dialect fixture.',
    messages: rows.map((message: any) => message.type === 'user' ? params.userMessageToMessageParam(message, false, false) : params.assistantMessageToMessageParam(message, false, false)),
    tools,
    output_config: { format: STRUCTURED_OUTPUT_ASK },
  }
  const family = bridge(messages)
  bodies[`openai-${name}`] = openai.buildOpenaiResponsesRequest({ model: 'fixture-openai-model', instructions: 'You are the dialect fixture.', messages: family, tools, outputFormat: STRUCTURED_OUTPUT_ASK })
  const compatible = chat.buildZaiChatRequest({ model: 'fixture-chat-model', system: 'You are the dialect fixture.', messages: family, tools })
  bodies[`chat-${name}`] = compatible
  bodies[`gemini-${name}`] = gemini.buildGeminiRequest(compatible, messages)
  bodies[`local-${name}`] = local.ollamaChatBody(compatible, { numCtx: 8192 })
}
const path = new URL('./dialect-goldens.json', import.meta.url)
if (recording) {
  assert.equal(root.endsWith('/base'), true, 'recording requires the archived original source tree')
  writeFileSync(path, JSON.stringify({ base: '71641f1bdcef83a22b5ab0a03cff54f004655af8', bodies }, null, 2) + '\n')
  console.log('RECORDED: ten complete request bodies from the archived original source tree')
} else {
  const golden = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(golden.base, '71641f1bdcef83a22b5ab0a03cff54f004655af8')
  assert.deepEqual(Object.keys(bodies).sort(), Object.keys(golden.bodies).sort())
  for (const [name, body] of Object.entries(bodies)) {
    assert.equal(canonicalJson(body), canonicalJson(golden.bodies[name]), `${name}: wire bytes changed`)
    console.log(`PASS: ${name} request bytes are identical to the original base`)
  }
}
