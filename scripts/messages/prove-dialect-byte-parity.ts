import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DIALECT_CONVERSATION, TWO_MODEL_COMPACTION, FIXTURE_TOOLS, STRUCTURED_OUTPUT_ASK, canonicalJson } from './dialectFixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const recording = process.argv[2] === '--record'
const checkout = new URL('../..', import.meta.url).pathname
assert.ok(!recording || (process.argv[3] && process.argv[4]), 'record with --record <archived-source/base> <committed-revision>')
const root = resolve(recording ? process.argv[3]! : checkout)
const git = (...args: string[]): string => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim()
let revision: string | undefined
if (recording) {
  assert.equal(root.endsWith('/base'), true, 'recording requires an archived source tree named base')
  revision = git('rev-parse', '--verify', `${process.argv[4]}^{commit}`)
  assert.match(revision, /^[a-f0-9]{40}$/)
  const entries = git('ls-tree', '-r', revision, '--', 'src', 'package.json', 'tsconfig.json').split('\n')
  assert.ok(entries.some(entry => entry.includes('\tsrc/')), 'the revision contains the provider source tree')
  for (const entry of entries) {
    const match = /^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(entry)
    if (!match) continue
    const bytes = readFileSync(join(root, match[2]!))
    const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    assert.equal(hash, match[1], `archived source differs from ${revision}: ${match[2]}`)
  }
}
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
  writeFileSync(path, JSON.stringify({ base: revision, bodies }, null, 2) + '\n')
  console.log(`RECORDED: ten complete request bodies from verified archive ${revision}`)
} else {
  const golden = JSON.parse(readFileSync(path, 'utf8'))
  assert.match(golden.base, /^[a-f0-9]{40}$/, 'the recording names its source revision')
  assert.deepEqual(Object.keys(bodies).sort(), Object.keys(golden.bodies).sort())
  for (const [name, body] of Object.entries(bodies)) {
    assert.equal(canonicalJson(body), canonicalJson(golden.bodies[name]), `${name}: canonical wire bytes changed`)
    assert.equal(JSON.stringify(body), JSON.stringify(golden.bodies[name]), `${name}: serialized wire bytes changed`)
    console.log(`PASS: ${name} request bytes are identical to recorded revision ${golden.base}`)
  }
}
