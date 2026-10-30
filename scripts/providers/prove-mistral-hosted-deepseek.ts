import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import type { Message, AssistantMessage } from '../../src/types/message.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const id = 'deepseek-v4-1-flash-1017'
const hosted = { id, created: 1793145600, max_context_length: 1000000, capabilities: { completion_chat: true, function_calling: true, reasoning: true, vision: false } }
const requests: Array<{ path: string; authorization: string | null; body?: Record<string, any> }> = []
let mistralStatus = 200
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request: Request) {
  const path = new URL(request.url).pathname
  const capture: typeof requests[number] = { path, authorization: request.headers.get('authorization') }
  requests.push(capture)
  if (path === '/mistral/models') return Response.json({ data: [hosted] }, { status: mistralStatus })
  if (path === '/deepseek/models') return Response.json({ data: [{ id: 'deepseek-flash' }] })
  if (path !== '/mistral/chat/completions') return new Response('Unexpected road', { status: 400 })
  capture.body = await request.json() as Record<string, any>
  return new Response(`data: ${JSON.stringify({ model: capture.body.model, choices: [{ index: 0, delta: { content: 'Mistral hosted reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 14, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
} })
const base = `http://127.0.0.1:${server.port}`
Object.assign(process.env, { MISTRAL_API_KEY: 'proof-key-mistral-hosted-not-real', DEEPSEEK_API_KEY: 'proof-key-deepseek-native-not-real', MERCURY_MISTRAL_API_BASE: `${base}/mistral`, MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek` })
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { classifyModelRoute, PROVIDER_ID_SPACES } = await import('../../src/services/providers/idSpaces.js')
const { canonicalWireModelId } = await import('../../src/services/providers/routeLaw.js')
const { parseUserSpecifiedModel, getPublicModelDisplayName } = await import('../../src/utils/model/model.js')
const cat = await import('../../src/services/providers/mistral/mistralCatalogue.js')
const { refreshDeepseekCatalogue } = await import('../../src/services/providers/deepseek/deepseekCatalogue.js')
const { buildProviderSnapshot } = await import('../../src/services/providers/modelRegistry.js')
await import('../../src/services/resources/registry.js')
const { knownModelsReference } = await import('../../src/services/resources/adapters/models.js')
const { validateModel } = await import('../../src/utils/model/validateModel.js')
const { getModelOptions, MISTRAL_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.js')
const { resolveModelPricing, getModelPricingString } = await import('../../src/utils/modelCost.js')
const { effortVocabularyFor, resolveContextWindow } = await import('../../src/utils/model/capabilities.js')
const { restoreConversationModel } = await import('../../src/utils/sessionRestore.js')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
async function turn(model: string, messages: Message[]) {
  const rows: AssistantMessage[] = []
  for await (const event of routedCallModel({ messages, systemPrompt: ['Fixture'], thinkingConfig: { type: 'enabled', budgetTokens: 10000 }, tools: [], signal: new AbortController().signal, options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } } as never)) if (event.type === 'assistant') rows.push(event)
  return rows
}
try {
  assert.deepEqual(classifyModelRoute(id), { kind: 'route', route: 'mistral' })
  assert.equal(cat.decodeMistralModel(hosted)?.id, id)
  assert.equal(cat.decodeMistralModel({ ...hosted, capabilities: { completion_chat: false } }), undefined)
  assert.equal(cat.decodeMistralModel({ ...hosted, id: 'deepseek-unpublished' }), undefined)
  for (const space of PROVIDER_ID_SPACES) {
    if (!space.qualifiedPrefix) continue
    const inner = space.innerGrammar === 'segments-2' ? `deepseek/${id}` : id
    const qualified = `${space.qualifiedPrefix}${inner}`
    assert.deepEqual(classifyModelRoute(qualified), { kind: 'route', route: space.route })
    const wire = canonicalWireModelId(qualified)
    assert.ok(wire.ok && wire.wireId === inner)
  }
  await refreshDeepseekCatalogue({ force: true })
  await cat.refreshMistralCatalogue({ force: true })
  assert.ok(buildProviderSnapshot().providers.filter(row => ['mistral', 'deepseek'].includes(row.id)).every(row => row.available))
  assert.equal(parseUserSpecifiedModel('mistral'), id)
  assert.equal(parseUserSpecifiedModel(id), id)
  assert.equal(buildProviderSnapshot().resolveExact(id)?.provider, 'mistral')
  assert.ok((await validateModel(id)).valid)
  assert.ok(getModelOptions().some(row => row.group === MISTRAL_MODEL_GROUP && row.value === id))
  assert.equal(getPublicModelDisplayName(id), 'DeepSeek V4.1 Flash 1017')
  assert.equal(resolveContextWindow(id).effectiveWindow, 1000000)
  assert.equal(effortVocabularyFor(id).kind, 'none')
  assert.equal(effortVocabularyFor(`${id}[1m]`).kind, 'none')
  assert.deepEqual(classifyModelRoute(` ${id.toUpperCase()}[served] `), { kind: 'route', route: 'mistral' })
  const known = await knownModelsReference()
  assert.ok(known.providers.find(row => row.provider === 'mistral')?.models.some(row => row.id === id))
  assert.deepEqual(classifyModelRoute('deepseek-flash'), { kind: 'route', route: 'deepseek' })
  const costs = resolveModelPricing(id).costs
  assert.deepEqual([costs.inputTokens, costs.promptCacheReadTokens, costs.outputTokens], [0.3, 0.007, 1.2])
  assert.equal(getModelPricingString(id), '$0.30/$1.20 per Mtok')
  const user = createUserMessage({ content: 'Use the selected Mistral model' })
  const first = await turn(parseUserSpecifiedModel('mistral'), [user])
  assert.ok(first.length > 0 && first.every(row => !row.isApiErrorMessage))
  const saved = JSON.parse(JSON.stringify({ model: id, messages: [user, ...first] }))
  cat.__resetMistralCatalogueForTest()
  assert.deepEqual(classifyModelRoute(id), { kind: 'route', route: 'mistral' })
  const resumed = restoreConversationModel(saved)
  assert.equal(resumed, id)
  assert.equal(restoreConversationModel({ messages: saved.messages }), id)
  const second = await turn(resumed!, [...saved.messages, createUserMessage({ content: 'Resume after catalogue refresh' })])
  assert.ok(second.length > 0 && second.every(row => !row.isApiErrorMessage))
  const chat = requests.filter(row => row.body !== undefined)
  assert.equal(chat.length, 2)
  assert.ok(chat.every(row => row.path === '/mistral/chat/completions' && row.authorization === 'Bearer proof-key-mistral-hosted-not-real' && row.body?.model === id))
  assert.ok(JSON.stringify(chat[1]!.body!.messages).includes('Mistral hosted reply'))
  assert.equal(requests.filter(row => row.path === '/mistral/models').length, 2)
  mistralStatus = 401
  await cat.refreshMistralCatalogue({ force: true })
  const refused = await turn(id, [user])
  assert.ok(refused.some(row => row.isApiErrorMessage && row.error === 'authentication_failed'))
  assert.ok(!requests.some(row => row.path === '/deepseek/chat/completions'))
  console.log('MISTRAL HOSTED DEEPSEEK GREEN: exact route, catalogue, selection, refresh, resume, lookup, known models, prices and carrier precedence')
} finally {
  server.stop(true)
  rmSync(proofHome, { recursive: true, force: true })
}
