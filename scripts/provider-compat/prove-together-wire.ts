import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import { TOGETHER_FIXTURE_MODELS } from '../providers/lib/openweights-fixture.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BUSY_RETRY_SCALE = '0.2'
process.env.TOGETHER_API_KEY = 'proof-key-together-wire-fixture-not-a-real-key'
type Mode = 'text' | 'tools' | 'malformed' | 'auth' | 'billing' | 'busy' | 'rate' | 'truncated' | 'invalid' | 'misplaced'
let mode: Mode = 'text'
let modelList: unknown = TOGETHER_FIXTURE_MODELS
let listStatus = 200
let listShape: 'array' | 'data' = 'array'
const captures: Array<{ path: string; body: Record<string, any>; bearer: boolean }> = []
let listReads = 0
const sse = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const bearer = req.headers.get('authorization') === `Bearer ${process.env.TOGETHER_API_KEY}`
  if (path === '/v1/models') {
    listReads++
    if (listStatus === 401) return Response.json({ error: { message: 'Invalid API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }, { status: 401 })
    if (listStatus === 500) return new Response('upstream unavailable', { status: 500 })
    return Response.json(listShape === 'array' ? modelList : { object: 'list', data: modelList })
  }
  assert.equal(path, '/v1/chat/completions')
  assert.equal(req.method, 'POST')
  const raw = await req.text()
  assert.ok(!raw.includes(process.env.TOGETHER_API_KEY!))
  const body = JSON.parse(raw)
  captures.push({ path, body, bearer })
  if (body.model === 'openai/gpt-oss-120b' && body.reasoning_effort !== undefined && !['low', 'medium', 'high'].includes(body.reasoning_effort)) return Response.json({ error: { message: `reasoning_effort '${body.reasoning_effort}' is not supported for this model`, type: 'invalid_request_error' } }, { status: 400 })
  if (body.model === 'deepseek-ai/DeepSeek-V4-Pro-0813' && body.reasoning_effort !== undefined && !['high', 'max'].includes(body.reasoning_effort)) return Response.json({ error: { message: `reasoning_effort '${body.reasoning_effort}' is not supported for this model`, type: 'invalid_request_error' } }, { status: 400 })
  if (mode === 'auth') return Response.json({ error: { message: 'Invalid API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }, { status: 401 })
  if (mode === 'billing') return Response.json({ error: { message: 'You have run out of credits.', type: 'credit_limit_exceeded', code: 'credit_limit_exceeded' } }, { status: 402 })
  if (mode === 'rate') return Response.json({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }, { status: 429, headers: { 'retry-after': '3600' } })
  if (mode === 'busy') { mode = 'text'; return Response.json({ error: { message: 'Service unavailable', type: 'server_error' } }, { status: 503 }) }
  if (mode === 'invalid') return Response.json({ error: { message: 'Input validation error', type: 'invalid_request_error' } }, { status: 422 })
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown, extra: Record<string, unknown> = {}): string => sse({ id: 'together-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish, ...extra }], ...(usage ? { usage } : {}) })
  let stream = chunk({ role: 'assistant', content: '' })
  const spelling = body.model === 'openai/gpt-oss-120b' || body.model === 'deepseek-ai/DeepSeek-V4-Pro-0813' ? 'reasoning' : 'reasoning_content'
  const thinks = body.reasoning?.enabled !== false
  if (mode === 'tools' || mode === 'malformed') {
    stream += chunk({ tool_calls: [{ index: 0, id: 'call_fixture_1', type: 'function', function: { name: 'FixtureEcho', arguments: mode === 'malformed' ? '{broken' : '{"text":' } }] })
    if (mode === 'tools') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] })
    stream += chunk({}, 'tool_calls', { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 })
  } else {
    if (mode === 'misplaced') stream += chunk({ content: 'TOGETHER-' }, null, undefined, { reasoning: 'misplaced on the choice' })
    else if (thinks) {
      stream += chunk({ [spelling]: 'Weighing the fixture' })
      stream += chunk({ [spelling]: ' carefully.', content: 'TOGETHER-' })
    } else stream += chunk({ content: 'TOGETHER-' })
    stream += chunk({ content: 'FIXTURE-SETTLED' })
    const cached = spelling === 'reasoning' ? { prompt_tokens_details: { cached_tokens: 4 } } : { cached_tokens: 4 }
    if (mode !== 'truncated') stream += chunk({}, 'stop', { prompt_tokens: 32, completion_tokens: 103, total_tokens: 135, ...cached })
  }
  if (mode === 'truncated') return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  return new Response(stream + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MERCURY_TOGETHER_API_BASE = `http://127.0.0.1:${server.port}/v1`
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
const { refreshTogetherCatalogue, __resetTogetherCatalogueForTest, togetherCatalogueRows, togetherCatalogueSourceWords, getCachedTogetherCatalogue } = await import('../../src/services/providers/together/togetherCatalogue.ts')
const { buildTogetherExtras } = await import('../../src/services/providers/together/togetherCallModel.ts')
const { storeTogetherApiKeyLogin } = await import('../../src/services/providers/together/togetherLogin.ts')
const { usageForProvider } = await import('../../src/services/providers/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
const { classifyModelRoute, canonicalWireModelId } = await import('../../src/services/providers/routeLaw.ts')
const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
const { keyLaneListState, keyLanePins } = await import('../../src/utils/model/modelOptions.ts')
const { readStoredTogetherApiKey } = await import('../../src/services/providers/providerSecrets.ts')
const { resolveContextWindow, modelThinkingAlwaysOn, effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
const { resolveEffortTruth } = await import('../../src/utils/effort.ts')
const { resolveModelPricing } = await import('../../src/utils/modelCost.ts')
const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
function params(model = 'together/moonshotai/Kimi-K3', effortValue: string | undefined = 'high', thinking = true, messages: Message[] = [createUserMessage({ content: 'hello fixture' })]): CompatCallModelParams {
  return { messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: thinking ? { type: 'enabled', budgetTokens: 4096 } : { type: 'disabled' }, signal: new AbortController().signal,
    options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue, maxOutputTokensOverride: 512 } as never }
}
async function run(p = params()): Promise<AssistantMessage[]> {
  const settled: AssistantMessage[] = []
  for await (const event of routedCallModel(p as never)) if (event.type === 'assistant') settled.push(event as AssistantMessage)
  return settled
}
const textOf = (rows: AssistantMessage[]): string => rows.flatMap(row => row.message.content).map(block => block.type === 'text' ? block.text : '').join('')
const thinkingOf = (rows: AssistantMessage[]): string => rows.flatMap(row => row.message.content).map(block => block.type === 'thinking' ? block.thinking : '').join('')
const words = (rows: AssistantMessage[]): string => rows.filter(row => row.isApiErrorMessage).map(row => JSON.stringify(row.message.content)).join(' ')
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
const section = (name: string): void => console.log(`\n── ${name}`)
try {
  section('routing')
  check('together/<org>/<model> routes to Together AI and the namespace detaches for the wire', classifyModelRoute(parseUserSpecifiedModel('together/moonshotai/Kimi-K3')).route === 'together' && canonicalWireModelId('together/moonshotai/Kimi-K3').ok && (canonicalWireModelId('together/moonshotai/Kimi-K3') as { wireId: string }).wireId === 'moonshotai/Kimi-K3')
  check('the bare slugs keep their own homes: moonshotai/Kimi-K3 is carrier-shaped, kimi-k3 is Moonshot, openrouter/moonshotai/kimi-k3 is OpenRouter', classifyModelRoute(parseUserSpecifiedModel('moonshotai/Kimi-K3')).kind === 'unrecognised' && classifyModelRoute(parseUserSpecifiedModel('kimi-k3')).route === 'moonshot' && classifyModelRoute(parseUserSpecifiedModel('openrouter/moonshotai/kimi-k3')).route === 'openrouter')
  check('a one-segment inner id is not a Together id: together/kimi-k3 fails the segments-2 grammar', !canonicalWireModelId('together/kimi-k3').ok)
  check('the key configures a Together backend but is not a claimed live turn', resolvePrimaryAgentBackend('together/zai-org/GLM-5.3')?.id === 'together-chat' && resolvePrimaryAgentBackend('together/zai-org/GLM-5.3')?.readiness().state === 'configured' && resolveProviderUsability().together.usable)

  section('the wire')
  const first = await run()
  const body = captures[0]!.body
  check("the gateway's chat list is read once and the wire carries the org/model slug without the namespace", listReads === 1 && body.model === 'moonshotai/Kimi-K3' && captures[0]?.bearer)
  check('the request streams with usage, function tools, auto choice and the session prompt_cache_key', body.stream === true && body.stream_options?.include_usage === true && body.tools[0].function.name === 'FixtureEcho' && body.tool_choice === 'auto' && typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.length > 0)
  check('a hybrid row takes reasoning.enabled from the thinking switch and no reasoning_effort', body.reasoning?.enabled === true && !('reasoning_effort' in body) && !('thinking' in body))
  check('an explicit output override rides max_tokens; sampling stays at the provider defaults', body.max_tokens === 512 && !('max_completion_tokens' in body) && !('temperature' in body))
  check('reasoning_content deltas become one thinking block and the visible text keeps every byte', thinkingOf(first) === 'Weighing the fixture carefully.' && textOf(first) === 'TOGETHER-FIXTURE-SETTLED')
  const usage = first.at(-1)?.message.usage
  check("the flat cached_tokens spelling (the vendor's non-reasoning rows) settles once from the final chunk", usage?.input_tokens === 28 && usage.cache_read_input_tokens === 4 && usage.output_tokens === 103)
  check('a settled turn alone advances the readiness receipt', resolvePrimaryAgentBackend('together/moonshotai/Kimi-K3')?.readiness().state === 'ready')
  const off = await run(params('together/moonshotai/Kimi-K3', 'high', false))
  check('thinking off on a hybrid row sends reasoning.enabled false and the reply carries no thinking block', captures.at(-1)?.body.reasoning?.enabled === false && thinkingOf(off) === '' && textOf(off) === 'TOGETHER-FIXTURE-SETTLED')
  const oss = await run(params('together/openai/gpt-oss-120b', 'max', true))
  check("gpt-oss-120b takes reasoning_effort clamped to the vendor's three words (max → high), streams delta.reasoning and nests its cached tokens", captures.at(-1)?.body.reasoning_effort === 'high' && !('reasoning' in captures.at(-1)!.body) && thinkingOf(oss) === 'Weighing the fixture carefully.' && oss.at(-1)?.message.usage?.cache_read_input_tokens === 4)
  await run(params('together/openai/gpt-oss-120b', 'high', false))
  check("thinking off on gpt-oss sends the lowest rung the vendor lists ('low') — the model cannot stop thinking", captures.at(-1)?.body.reasoning_effort === 'low')
  await run(params('together/deepseek-ai/DeepSeek-V4-Pro-0813', 'low', true))
  check("DeepSeek V4 Pro takes both the toggle and the two-word dial: 'low' rises to its floor 'high'", captures.at(-1)?.body.reasoning?.enabled === true && captures.at(-1)?.body.reasoning_effort === 'high')
  await run(params('together/deepseek-ai/DeepSeek-V4-Pro-0813', 'max', false))
  check('with thinking off DeepSeek V4 Pro sends the toggle off and no effort word', captures.at(-1)?.body.reasoning?.enabled === false && !('reasoning_effort' in captures.at(-1)!.body))
  await run(params('together/fixture-org/Fixture-Chat-1', 'high', true))
  check('a live-listed chat row this build has no pin for rides with only the usage and cache knobs', captures.at(-1)?.body.model === 'fixture-org/Fixture-Chat-1' && !('reasoning' in captures.at(-1)!.body) && !('reasoning_effort' in captures.at(-1)!.body))
  await run(params('together/MOONSHOTAI/kimi-k3', 'high', true))
  check("a slug typed in another case dispatches as the listed row the gateway spells", captures.at(-1)?.body.model === 'moonshotai/Kimi-K3')
  check('unknown model facts invent no dial', JSON.stringify(buildTogetherExtras({ wireModel: 'fixture-org/unknown', effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: undefined })) === '{"stream_options":{"include_usage":true}}')
  mode = 'tools'
  const tools = await run()
  const calls = tools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use')
  check('fragmented tool arguments become one validated executable call under the provider id', calls.length === 1 && calls[0]?.type === 'tool_use' && calls[0].id === 'call_fixture_1' && JSON.stringify(calls[0].input) === '{"text":"hello"}')
  mode = 'text'
  await run(params('together/moonshotai/Kimi-K3', 'high', true, [...tools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_fixture_1', content: 'echo:hello' }] })]))
  const history = captures.at(-1)!.body.messages
  check('tool results replay with the matching assistant call and no private reasoning', history.some((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'call_fixture_1') && history.some((row: any) => row.role === 'tool' && row.tool_call_id === 'call_fixture_1') && history.every((row: any) => !('reasoning_content' in row)))
  const dispatch = await resolveEngineDispatch('together')
  check("the Agent class word 'together' selects the gateway's first listed chat row, pinned first", dispatch?.backend === 'together' && dispatch.model === 'together/moonshotai/Kimi-K3')
  const exact = await resolveEngineDispatch('together/Prism-ML/Ternary-Bonsai-27B')
  check('an exact together/ id dispatches as listed, labelled free without duplicating (free) in keyLanePins', exact?.model === 'together/Prism-ML/Ternary-Bonsai-27B' && exact.displayLabel === 'Ternary Bonsai 27B (free)' && keyLanePins('together').find(pin => pin.id === 'together/Prism-ML/Ternary-Bonsai-27B')?.displayName === 'Ternary Bonsai 27B (free)')
  check('the context window, the always-on verdict, the thinking-off effort truth and the effort vocabulary read the pins and the live list', resolveContextWindow('together/moonshotai/Kimi-K3').effectiveWindow === 1_048_576 && modelThinkingAlwaysOn('together/openai/gpt-oss-120b') && !modelThinkingAlwaysOn('together/moonshotai/Kimi-K3') && JSON.stringify(effortVocabularyFor('together/openai/gpt-oss-120b')).includes('"vocabulary":["low","medium","high"]') && resolveEffortTruth('together/deepseek-ai/DeepSeek-V4-Pro-0813', 'max', { thinkingEnabled: false }).wire === undefined && resolveEffortTruth('together/openai/gpt-oss-120b', 'max', { thinkingEnabled: false }).wire === 'low' && resolveModelPricing('together/moonshotai/Kimi-K3').basis === 'recorded')

  section('the catalogue and the login')
  const rows = togetherCatalogueRows()
  check('the picker lists the chat rows only, pinned first then the rest, with image, audio and moderation rows set aside', rows.source.kind === 'live' && rows.rows.length === 6 && rows.rows[0]?.id === 'together/moonshotai/Kimi-K3' && rows.rows.at(-1)?.id === 'together/fixture-org/Fixture-Chat-1' && rows.source.otherKinds === 3 && (togetherCatalogueSourceWords() ?? '').includes('3 image, video, audio and other rows not listed') && keyLanePins('together').some(pin => pin.id === 'together/fixture-org/Fixture-Chat-1' && pin.liveUnknown === true))
  listShape = 'data'; __resetTogetherCatalogueForTest(); await refreshTogetherCatalogue({ force: true })
  check('the { data: [...] } list shape decodes the same rows', getCachedTogetherCatalogue()?.models.length === 6)
  listShape = 'array'
  const stored = await storeTogetherApiKeyLogin('proof-key-together-login-fixture-not-a-real-key')
  check('a key the list accepts is stored with the chat count and the rows set aside in the receipt', stored.ok && stored.stored && readStoredTogetherApiKey() === 'proof-key-together-login-fixture-not-a-real-key' && stored.receipt.includes('6 chat models listed') && stored.receipt.includes('3 image, video and audio rows set aside') && stored.receipt.includes('TOGETHER_API_KEY is set and wins'))
  const view = usageForProvider('together')
  check('/usage names the session spend and the console for the balance; no meter is invented', view.sourceKind === 'api-key' && view.windows.length === 0 && view.credits.state === 'unreported' && (view.absence ?? '').includes('api.together.ai/settings/billing'))

  section('refusals')
  mode = 'auth'
  let before = captures.length
  const auth = await run()
  check('a key the vendor refuses with HTTP 401 refuses once with the Together remedy, never a hop', captures.length === before + 1 && auth.some(row => row.isApiErrorMessage && row.error === 'authentication_failed') && words(auth).includes('/logins together'))
  mode = 'billing'
  before = captures.length
  const billing = await run()
  check('a 402 out-of-credits answer is a billing refusal that belongs to Together alone', captures.length === before + 1 && billing.some(row => row.isApiErrorMessage && row.error === 'billing_error') && laneBillingState('together').state === 'credit-exhausted' && laneBillingState('minimax').state === 'clear')
  mode = 'rate'
  before = captures.length
  const rate = await run()
  check("a 429 with the vendor's retry-after names the wait and stays on the lane: one request, no hop", captures.length === before + 1 && rate.some(row => row.isApiErrorMessage && row.error === 'rate_limit') && words(rate).includes('asks for a 1h wait'))
  mode = 'busy'
  before = captures.length
  await run()
  check('a provider overload retries its own lane then clears its billing state', captures.length === before + 2 && laneBillingState('together').state === 'clear')
  mode = 'text'
  await run(params('together/openai/gpt-oss-120b', 'xhigh', true))
  check("an effort word the row lacks is clamped to the nearest the vendor lists ('xhigh' → 'high'), never a 400", captures.at(-1)?.body.reasoning_effort === 'high')
  mode = 'misplaced'
  const misplaced = await run()
  check('a reasoning field in the wrong place (on the choice, not the delta) is ignored: no invented thinking, the text intact, the turn settled', thinkingOf(misplaced) === '' && textOf(misplaced) === 'TOGETHER-FIXTURE-SETTLED' && !misplaced.some(row => row.isApiErrorMessage))
  mode = 'malformed'
  check('malformed tool JSON cannot become an executable call', !(await run()).some(row => row.message.content.some(block => block.type === 'tool_use')))
  mode = 'truncated'
  check('an unterminated stream does not count as success', (await run()).some(row => row.isApiErrorMessage))
  mode = 'invalid'
  check('a vendor 422 validation error settles as a typed refusal without an overflow stamp', (await run()).every(row => row.overflowSignal === undefined && (!row.isApiErrorMessage || row.error === 'invalid_request')))
  mode = 'text'
  before = captures.length
  const image = await run(params('together/black-forest-labs/FLUX.1-schnell'))
  check("a row the gateway lists outside the chat kind (an image model) refuses before any request as not on the chat list", captures.length === before && image.some(row => row.isApiErrorMessage) && words(image).includes('black-forest-labs/FLUX.1-schnell'))
  const absent = await run(params('together/fixture-org/absent-model'))
  check('an id the gateway does not list refuses before inference', captures.length === before && absent.some(row => row.isApiErrorMessage))
  const bareNamespace = await run(params('together/'))
  check('an empty inner id refuses before inference, naming the namespace', captures.length === before && bareNamespace.some(row => row.isApiErrorMessage) && words(bareNamespace).includes('together/'))
  modelList = []; __resetTogetherCatalogueForTest(); await refreshTogetherCatalogue({ force: true })
  const emptyPins = togetherCatalogueRows()
  check('an empty live list falls to the 24 pins labelled as pins, and a pinned id still rides under the note', emptyPins.source.kind === 'pins' && emptyPins.rows.length === 24 && emptyPins.rows.every(row => row.listedLive === false && row.observedAt === '2026-10-17') && keyLaneListState('together').kind === 'pin' && (togetherCatalogueSourceWords() ?? '').includes('pinned list (observed 2026-10-17)') && !(await run(params('together/zai-org/GLM-5.3'))).some(row => row.isApiErrorMessage) && captures.length === before + 1)
  before = captures.length
  modelList = TOGETHER_FIXTURE_MODELS
  listStatus = 401; __resetTogetherCatalogueForTest(); await refreshTogetherCatalogue({ force: true })
  const refusedList = await run()
  check('a refused list is an auth refusal with the key remedy, before any chat request', refusedList.some(row => row.isApiErrorMessage && row.error === 'authentication_failed') && words(refusedList).includes('/logins together') && captures.length === before)
  const refusedLogin = await storeTogetherApiKeyLogin('proof-key-together-refused-fixture-not-a-real-key')
  check('a key the list refuses is never stored and the receipt names the key page', !refusedLogin.ok && !refusedLogin.stored && refusedLogin.receipt.includes('HTTP 401') && refusedLogin.receipt.includes('api.together.ai') && readStoredTogetherApiKey() === 'proof-key-together-login-fixture-not-a-real-key')
  listStatus = 500
  __resetTogetherCatalogueForTest()
  await refreshTogetherCatalogue({ force: true })
  const pinRows = togetherCatalogueRows()
  check('with the list unreachable the picker shows the 24 pins, labelled as pins, dated from the vendor page', pinRows.source.kind === 'pins' && pinRows.rows.length === 24 && pinRows.rows.every(row => row.listedLive === false && row.observedAt === '2026-10-17' && row.id.startsWith('together/')) && keyLaneListState('together').kind === 'pin' && (togetherCatalogueSourceWords() ?? '').includes('pinned list (observed 2026-10-17)') && (togetherCatalogueSourceWords() ?? '').includes('HTTP 500'))
  before = captures.length
  const unreachableTurn = await run(params('together/zai-org/GLM-5.3'))
  check('with the list unreachable a pinned id still rides, with the note that the gateway decides', captures.length === before + 1 && captures.at(-1)?.body.model === 'zai-org/GLM-5.3' && textOf(unreachableTurn).startsWith('Together AI model list unavailable') && textOf(unreachableTurn).endsWith('TOGETHER-FIXTURE-SETTLED'))
  listStatus = 200
  __resetTogetherCatalogueForTest()
  const aborted = new AbortController(); aborted.abort()
  check('pre-aborted calls return quietly without a chat request', (await run({ ...params(), signal: aborted.signal })).length === 0 && captures.length === before + 1)
  console.log(`TOGETHER WIRE GREEN (${count} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
