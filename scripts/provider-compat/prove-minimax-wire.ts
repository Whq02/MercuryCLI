import '../lib/hermetic.ts'
import { assertRefusedCallResult } from '../providers/lib/refused-call-result.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import { MINIMAX_FIXTURE_MODELS, MINIMAX_FIXTURE_PLAN } from '../providers/lib/openweights-fixture.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BUSY_RETRY_SCALE = '0.2'
process.env.MINIMAX_API_KEY = 'proof-key-minimax-wire-fixture-not-a-real-key'
type Mode = 'text' | 'tools' | 'malformed' | 'auth' | 'auth-envelope' | 'billing-envelope' | 'billing-http-envelope' | 'rate-envelope' | 'busy' | 'rate' | 'truncated' | 'invalid' | 'misplaced'
let mode: Mode = 'text'
let modelList: unknown[] = MINIMAX_FIXTURE_MODELS
let listStatus = 200
let planBody: unknown = MINIMAX_FIXTURE_PLAN
let planStatus = 200
const captures: Array<{ path: string; body: Record<string, any>; bearer: boolean }> = []
let listReads = 0
const sse = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const bearer = req.headers.get('authorization') === `Bearer ${process.env.MINIMAX_API_KEY}`
  if (path === '/v1/models') {
    listReads++
    if (listStatus === 401) return Response.json({ error: { message: 'invalid api key', type: 'authentication_error' } }, { status: 401 })
    if (listStatus === 299) return Response.json({ base_resp: { status_code: 1004, status_msg: 'not authorized' } })
    return Response.json({ object: 'list', data: modelList, base_resp: { status_code: 0, status_msg: '' } })
  }
  if (path === '/v1/token_plan/remains') {
    if (planStatus === 401) return Response.json({ base_resp: { status_code: 2049, status_msg: 'invalid API Key' } }, { status: 401 })
    if (planStatus === 204) return new Response('', { status: 200 })
    return Response.json(planBody, { status: planStatus })
  }
  assert.equal(path, '/v1/chat/completions')
  assert.equal(req.method, 'POST')
  const raw = await req.text()
  assert.ok(!raw.includes(process.env.MINIMAX_API_KEY!))
  const body = JSON.parse(raw)
  captures.push({ path, body, bearer })
  if (body.model === 'MiniMax-M3.1-Flash-Preview' && (body.reasoning_effort === 'none' || body.reasoning_effort === 'minimal' || body.thinking?.type === 'disabled' || body.reasoning_split === false)) {
    return Response.json({ error: { message: 'model "MiniMax-M3.1-Flash-Preview" requires adaptive thinking; thinking.type="disabled" (including reasoning.effort=none) is not allowed (2013)', type: 'invalid_request_error' } }, { status: 400 })
  }
  if (mode === 'auth') return Response.json({ error: { message: 'invalid api key', type: 'authentication_error' } }, { status: 401 })
  if (mode === 'auth-envelope') return Response.json({ id: 'x', choices: [], base_resp: { status_code: 1004, status_msg: 'not authorized / token not match group' } })
  if (mode === 'billing-envelope') return Response.json({ id: 'x', choices: [], base_resp: { status_code: 1008, status_msg: 'insufficient balance' } })
  if (mode === 'billing-http-envelope') return Response.json({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }, { status: 400 })
  if (mode === 'rate') return Response.json({ error: { message: 'rate limit', type: 'rate_limit_error' } }, { status: 429, headers: { 'retry-after': '3600' } })
  if (mode === 'busy') { mode = 'text'; return Response.json({ error: { message: 'Service unavailable', type: 'server_error' } }, { status: 503 }) }
  if (mode === 'invalid') return Response.json({ base_resp: { status_code: 2013, status_msg: 'invalid params' } }, { status: 400 })
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown, extra: Record<string, unknown> = {}): string => sse({ id: 'minimax-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish, ...extra }], ...(usage ? { usage, base_resp: { status_code: 0, status_msg: '' } } : {}) })
  let stream = chunk({ role: 'assistant', content: '' })
  if (mode === 'rate-envelope') {
    stream += sse({ id: 'minimax-fixture', object: 'chat.completion.chunk', choices: [], base_resp: { status_code: 1002, status_msg: 'rate limit' } })
    return new Response(stream + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  if (mode === 'tools' || mode === 'malformed') {
    stream += chunk({ reasoning_content: 'Calling the echo tool.' })
    stream += chunk({ tool_calls: [{ index: 0, id: 'call_function_fixture_1', type: 'function', function: { name: 'FixtureEcho', arguments: mode === 'malformed' ? '{broken' : '{"text":' } }] })
    if (mode === 'tools') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] })
    stream += chunk({}, 'tool_calls', { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 })
  } else {
    if (mode === 'misplaced') stream += chunk({ content: 'MINIMAX-' }, null, undefined, { reasoning_content: 'misplaced on the choice' })
    else if (body.model === 'MiniMax-M3' ? body.thinking?.type !== 'disabled' : true) {
      stream += chunk({ reasoning_content: 'Weighing the fixture' })
      stream += chunk({ reasoning_content: ' carefully.', content: 'MINIMAX-' })
    } else stream += chunk({ content: 'MINIMAX-' })
    stream += chunk({ content: 'FIXTURE-SETTLED' })
    if (mode !== 'truncated') stream += chunk({}, 'stop', { prompt_tokens: 32, completion_tokens: 103, total_tokens: 135, prompt_tokens_details: { cached_tokens: 4 } })
  }
  if (mode === 'truncated') return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  return new Response(stream + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MERCURY_MINIMAX_API_BASE = `http://127.0.0.1:${server.port}/v1`
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
const { refreshMinimaxCatalogue, __resetMinimaxCatalogueForTest, minimaxCatalogueRows, minimaxCatalogueSourceWords } = await import('../../src/services/providers/minimax/minimaxCatalogue.ts')
const { buildMinimaxExtras } = await import('../../src/services/providers/minimax/minimaxCallModel.ts')
const { storeMinimaxApiKeyLogin } = await import('../../src/services/providers/minimax/minimaxLogin.ts')
const { fetchMinimaxPlanUsage, refreshMinimaxPlanUsage, minimaxObservedPlanUsage, minimaxPlanFailureWords, __resetMinimaxUsageForTest } = await import('../../src/services/providers/minimax/minimaxUsageState.ts')
const { minimaxPlanWindowViews, usageForProvider, refreshProviderUsage } = await import('../../src/services/providers/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
const { classifyModelRoute } = await import('../../src/services/providers/routeLaw.ts')
const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
const { keyLaneListState, keyLanePins } = await import('../../src/utils/model/modelOptions.ts')
const { readStoredMinimaxApiKey } = await import('../../src/services/providers/providerSecrets.ts')
const { buildMistralExtras } = await import('../../src/services/providers/mistral/mistralCallModel.ts')
const { buildZenExtras } = await import('../../src/services/providers/zen/zenCallModel.ts')
const { buildMetaExtras } = await import('../../src/services/providers/meta/metaCallModel.ts')
const { nousLaneProfile } = await import('../../src/services/providers/nous/nousCallModel.ts')
const { buildMoonshotExtras, buildDeepseekExtras, buildOpenrouterExtras, buildXaiExtras, buildCompatSlotExtras, buildHuggingfaceExtras, buildGeminiExtras, buildLocalExtras } = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { configureEffortParams } = await import('../../src/services/providers/anthropic/requestParams.ts')
const { buildOpenaiResponsesRequest } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { buildZaiChatRequest } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { compatFaultToTypedError } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
function params(model = 'minimax', effortValue: string | undefined = 'max', thinking = true, messages: Message[] = [createUserMessage({ content: 'hello fixture' })]): CompatCallModelParams {
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
  check('the bare prefix, the vendor casing and the family word route to MiniMax', ['minimax-m3', 'MiniMax-M3', 'minimax-m3.1-flash-preview', 'MiniMax-M2.7', 'minimax'].every(id => classifyModelRoute(parseUserSpecifiedModel(id)).route === 'minimax'))
  check('the qualified namespaces keep their own MiniMax rows: zen/minimax-m3 is Zen, together/MiniMaxAI/MiniMax-M3 is Together', classifyModelRoute(parseUserSpecifiedModel('zen/minimax-m3')).route === 'zen' && classifyModelRoute(parseUserSpecifiedModel('together/MiniMaxAI/MiniMax-M3')).route === 'together')
  check('the key configures a MiniMax backend but is not a claimed live turn', resolvePrimaryAgentBackend('minimax-m3')?.id === 'minimax-chat' && resolvePrimaryAgentBackend('minimax')?.readiness().state === 'configured' && resolveProviderUsability().minimax.usable)

  section('the wire')
  const first = await run()
  const body = captures[0]!.body
  check("the family word reads the account list once and selects MiniMax-M3, the first served pin, in the vendor's spelling", listReads === 1 && body.model === 'MiniMax-M3' && captures[0]?.bearer)
  check('every request asks for split reasoning and the usage chunk, with function tools, auto choice and streaming', body.reasoning_split === true && body.stream_options?.include_usage === true && body.stream === true && body.tools[0].function.name === 'FixtureEcho' && body.tool_choice === 'auto')
  check('MiniMax-M3 with thinking on sends the adaptive thinking toggle and no effort word (the dial is M3.1-only)', body.thinking?.type === 'adaptive' && !('reasoning_effort' in body) && !('reasoning' in body))
  check('an explicit output override rides max_completion_tokens; max_tokens and sampling stay off the wire', body.max_completion_tokens === 512 && !('max_tokens' in body) && !('temperature' in body) && !('top_p' in body))
  check('reasoning_content deltas become one thinking block and the visible text keeps every byte', thinkingOf(first) === 'Weighing the fixture carefully.' && textOf(first) === 'MINIMAX-FIXTURE-SETTLED')
  const usage = first.at(-1)?.message.usage
  check('cached input tokens and completion tokens settle once from the final chunk', usage?.input_tokens === 28 && usage.cache_read_input_tokens === 4 && usage.output_tokens === 103)
  check('a settled turn alone advances the readiness receipt', resolvePrimaryAgentBackend('minimax')?.readiness().state === 'ready')
  const off = await run(params('MiniMax-M3', 'max', false))
  check('thinking off on MiniMax-M3 sends thinking.type disabled, never an effort word, and the reply carries no thinking block', captures.at(-1)?.body.thinking?.type === 'disabled' && !('reasoning_effort' in captures.at(-1)!.body) && thinkingOf(off) === '' && textOf(off) === 'MINIMAX-FIXTURE-SETTLED')
  await run(params('minimax-m3.1-flash-preview', 'max', true))
  check('a lowercase typed id dispatches as the listed row the vendor spells, and M3.1 takes reasoning_effort max with no thinking field', captures.at(-1)?.body.model === 'MiniMax-M3.1-Flash-Preview' && captures.at(-1)?.body.reasoning_effort === 'max' && !('thinking' in captures.at(-1)!.body))
  await run(params('MiniMax-M3.1-Flash-Preview', 'xhigh', true))
  check('every rung the vendor lists is sent as asked', captures.at(-1)?.body.reasoning_effort === 'xhigh')
  await run(params('MiniMax-M2.7', 'high', true))
  check('an M2.x row sends neither a thinking toggle nor an effort word — the vendor states thinking always on', !('thinking' in captures.at(-1)!.body) && !('reasoning_effort' in captures.at(-1)!.body) && captures.at(-1)?.body.model === 'MiniMax-M2.7')
  await run(params('MiniMax-M2.1', 'high', true))
  check('a live-listed row this build has no pin for rides with only the split and usage knobs', captures.at(-1)?.body.model === 'MiniMax-M2.1' && captures.at(-1)?.body.reasoning_split === true && !('thinking' in captures.at(-1)!.body) && !('reasoning_effort' in captures.at(-1)!.body))
  check('unknown model facts invent neither a dial nor an output ceiling', JSON.stringify(buildMinimaxExtras({ wireModel: 'MiniMax-Fixture-Unknown', effortValue: 'max', thinkingEnabled: false, maxOutputTokensOverride: undefined })) === '{"reasoning_split":true,"stream_options":{"include_usage":true}}')
  mode = 'tools'
  const tools = await run(params('MiniMax-M3'))
  const calls = tools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use')
  check('fragmented tool arguments become one validated executable call under the provider id', calls.length === 1 && calls[0]?.type === 'tool_use' && calls[0].id === 'call_function_fixture_1' && JSON.stringify(calls[0].input) === '{"text":"hello"}')
  mode = 'text'
  await run(params('MiniMax-M3', 'high', true, [...tools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_function_fixture_1', content: 'echo:hello' }] })]))
  const history = captures.at(-1)!.body.messages
  check('the tool round replays the assistant call with its reasoning_content, as the vendor asks for multi-turn tool use', history.some((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'call_function_fixture_1' && row.reasoning_content === 'Calling the echo tool.') && history.some((row: any) => row.role === 'tool' && row.tool_call_id === 'call_function_fixture_1'))
  const dispatch = await resolveEngineDispatch('minimax')
  check("the Agent class word 'minimax' selects the same served MiniMax-M3 row", dispatch?.backend === 'minimax' && dispatch.model === 'MiniMax-M3')

  section('the login and the plan window')
  const stored = await storeMinimaxApiKeyLogin('proof-key-minimax-login-fixture-not-a-real-key')
  check('a key the list and the plan endpoint accept is stored with the plan windows in the receipt', stored.ok && stored.stored && readStoredMinimaxApiKey() === 'proof-key-minimax-login-fixture-not-a-real-key' && stored.receipt.includes('5 text models listed') && stored.receipt.includes('M Plan') && stored.receipt.includes('MiniMax-M3 5 hour 38%') && stored.receipt.includes('weekly 19%') && stored.receipt.includes('MINIMAX_API_KEY is set and wins'))
  planBody = { model_remains: [] }
  const payg = await storeMinimaxApiKeyLogin('proof-key-minimax-payg-fixture-not-a-real-key')
  check('a pay-as-you-go key stores with no plan window named', payg.ok && payg.receipt.includes('no M Plan window — pay-as-you-go'))
  for (const [status, body] of [[403, { base_resp: { status_code: 1004, status_msg: 'token not match group' } }], [404, { error: 'not found' }], [204, null]] as const) {
    planStatus = status; planBody = body
    __resetMinimaxUsageForTest()
    const nonPlanLogin = await storeMinimaxApiKeyLogin('proof-key-minimax-payg-fixture-not-a-real-key')
    await refreshProviderUsage('minimax', { force: true })
    const nonPlanView = usageForProvider('minimax')
    check(`a ${status === 204 ? 'missing' : status} plan answer for a non-plan key paints NO window and NO error`, nonPlanLogin.ok && nonPlanLogin.stored && nonPlanLogin.receipt.includes('no M Plan window — pay-as-you-go') && nonPlanView.windows.length === 0 && nonPlanView.readerNote === undefined && minimaxObservedPlanUsage().failure === null)
  }
  const LOGIN_FAIL = "login fail: Please carry the API secret key in the 'Authorization' field of the request header"
  planStatus = 200; planBody = { base_resp: { status_code: 1004, status_msg: LOGIN_FAIL } }
  __resetMinimaxUsageForTest()
  const loginFail = await fetchMinimaxPlanUsage(process.env.MINIMAX_API_KEY!)
  check("the plan endpoint's HTTP 200 with base_resp 1004 'login fail' (the wire's answer to a wrong key) is a credential refusal with the vendor's words, never 'no plan'", loginFail.state === 'refused' && loginFail.status === 401 && loginFail.message === LOGIN_FAIL && minimaxObservedPlanUsage().failure?.kind === 'refused' && minimaxObservedPlanUsage().failure?.message === LOGIN_FAIL && minimaxPlanFailureWords(minimaxObservedPlanUsage().failure!) === `MiniMax refused the key on the plan read (HTTP 401) — ${LOGIN_FAIL} — /logins minimax replaces it`)
  await refreshProviderUsage('minimax', { force: true })
  check('/usage carries that refusal with the words', (usageForProvider('minimax').readerNote ?? '').includes(`MiniMax refused the key on the plan read (HTTP 401) — ${LOGIN_FAIL}`))
  const deadPlanLogin = await storeMinimaxApiKeyLogin('proof-key-minimax-deadplan-fixture-not-a-real-key')
  check("a key the list accepts but the plan read answers 1004 'login fail' is refused at /logins with the words, nothing stored", !deadPlanLogin.ok && !deadPlanLogin.stored && deadPlanLogin.receipt.includes(`MiniMax refused this key on the plan read (HTTP 401, ${LOGIN_FAIL})`) && readStoredMinimaxApiKey() === 'proof-key-minimax-payg-fixture-not-a-real-key')
  planBody = { base_resp: { status_code: 2049, status_msg: 'invalid API Key' } }
  const invalidKey = await fetchMinimaxPlanUsage(process.env.MINIMAX_API_KEY!)
  check("2049 'invalid API Key' on a 200 body is the same refusal", invalidKey.state === 'refused' && invalidKey.message === 'invalid API Key')
  planStatus = 200; planBody = MINIMAX_FIXTURE_PLAN
  __resetMinimaxUsageForTest()
  await refreshMinimaxPlanUsage({ force: true })
  const views = minimaxPlanWindowViews(minimaxObservedPlanUsage())
  check('/usage paints the 5-hour and weekly windows from the plan endpoint with their resets', views.length === 2 && views[0]?.key === '5h' && views[0].usedPct === 38 && views[0].resetsAtMs === 1_792_068_000_000 && views[1]?.key === 'wk' && views[1].usedPct === 19 && views[1].label === 'M Plan weekly')
  await refreshProviderUsage('minimax', { force: true })
  const view = usageForProvider('minimax')
  check('the provider usage view carries the windows and says the balance lives on the platform', view.sourceKind === 'api-key' && view.windows.length === 2 && view.credits.state === 'unreported' && (view.absence ?? '').includes('platform.minimax.io'))

  section('refusals')
  mode = 'auth'
  let before = captures.length
  const auth = await run(params('MiniMax-M3'))
  check('a key the vendor refuses with HTTP 401 refuses once with the MiniMax remedy, never a hop', captures.length === before + 1 && auth.some(row => row.isApiErrorMessage && row.error === 'authentication_failed') && words(auth).includes('/logins minimax'))
  mode = 'auth-envelope'
  before = captures.length
  const envelope = await run(params('MiniMax-M3'))
  check("the vendor's 200-body envelope (base_resp 1004) is the same typed key refusal, read once, never retried as an empty stream", captures.length === before + 1 && envelope.some(row => row.isApiErrorMessage && row.error === 'authentication_failed') && words(envelope).includes('minimax-1004') && words(envelope).includes('not authorized'))
  mode = 'billing-envelope'
  before = captures.length
  const billing = await run(params('MiniMax-M3'))
  check('base_resp 1008 is a billing refusal that belongs to MiniMax, not another family', captures.length === before + 1 && billing.some(row => row.isApiErrorMessage && row.error === 'billing_error') && laneBillingState('minimax').state === 'credit-exhausted' && laneBillingState('mistral').state === 'clear')
  mode = 'billing-http-envelope'
  before = captures.length
  const billingHttp = await run(params('MiniMax-M3'))
  check('base_resp 1008 on a non-200 HTTP response keeps its minimax-1008 code, status_msg and billing_error class', captures.length === before + 1 && billingHttp.some(row => row.isApiErrorMessage && row.error === 'billing_error') && words(billingHttp).includes('minimax-1008') && words(billingHttp).includes('insufficient balance'))
  check('every documented base_resp numeric code maps to its typed refusal class (auth 1004/2049 · balance 1008 · rate/usage 1002/1039/1041/2045/2056 · params/content 1026/1027/1042/2013 · server/timeout 1000/1001/1013/1024/1033)',
    [1004, 2049].every(c => compatFaultToTypedError({ kind: 'api-error', code: `minimax-${c}` }) === 'authentication_failed') &&
    compatFaultToTypedError({ kind: 'api-error', code: 'minimax-1008' }) === 'billing_error' &&
    [1002, 1039, 1041, 2045, 2056].every(c => compatFaultToTypedError({ kind: 'api-error', code: `minimax-${c}` }) === 'rate_limit') &&
    [1026, 1027, 1042, 2013].every(c => compatFaultToTypedError({ kind: 'api-error', code: `minimax-${c}` }) === 'invalid_request') &&
    [1000, 1001, 1013, 1024, 1033].every(c => compatFaultToTypedError({ kind: 'api-error', code: `minimax-${c}` }) === 'server_error'))
  mode = 'rate-envelope'
  before = captures.length
  const rateEnvelope = await run(params('MiniMax-M3'))
  check('base_resp 1002 inside an SSE chunk is a typed rate limit, not a clean stop', rateEnvelope.some(row => row.isApiErrorMessage && row.error === 'rate_limit') && captures.length === before + 1)
  mode = 'rate'
  before = captures.length
  const rate = await run(params('MiniMax-M3'))
  check("a 429 with the vendor's retry-after names the wait and stays on the lane: one request, no hop", captures.length === before + 1 && rate.some(row => row.isApiErrorMessage && row.error === 'rate_limit') && words(rate).includes('asks for a 1h wait'))
  mode = 'busy'
  before = captures.length
  await run(params('MiniMax-M3'))
  check('a provider overload retries its own lane then clears its billing state', captures.length === before + 2 && laneBillingState('minimax').state === 'clear')
  mode = 'text'
  await run(params('MiniMax-M3.1-Flash-Preview', 'minimal', true))
  check("an effort word the family lacks is clamped to the nearest the vendor lists ('minimal' → 'low'), never a 400", captures.at(-1)?.body.reasoning_effort === 'low' && captures.at(-1)?.body.model === 'MiniMax-M3.1-Flash-Preview')
  const offFlash = await run(params('MiniMax-M3.1-Flash-Preview', 'max', false))
  check("thinking off on M3.1 sends the lowest rung the vendor serves ('low'), never 'none' and never thinking.disabled — the vendor answers both with HTTP 400", captures.at(-1)?.body.reasoning_effort === 'low' && !('thinking' in captures.at(-1)!.body) && textOf(offFlash) === 'MINIMAX-FIXTURE-SETTLED')
  mode = 'misplaced'
  const misplaced = await run(params('MiniMax-M3'))
  check('a reasoning field in the wrong place (on the choice, not the delta) is ignored: no invented thinking, the text intact, the turn settled', thinkingOf(misplaced) === '' && textOf(misplaced) === 'MINIMAX-FIXTURE-SETTLED' && !misplaced.some(row => row.isApiErrorMessage))
  mode = 'malformed'
  check('malformed tool arguments keep their call identity and receive an error result without execution', await assertRefusedCallResult(await run(params('MiniMax-M3')), { id: 'call_function_fixture_1', name: 'FixtureEcho', raw: '{broken' }))
  mode = 'truncated'
  check('an unterminated stream does not count as success', (await run(params('MiniMax-M3'))).some(row => row.isApiErrorMessage))
  mode = 'invalid'
  const invalidRows = await run(params('MiniMax-M3'))
  check('a vendor 400 with base_resp 2013 settles as a typed refusal carrying minimax-2013 and status_msg without an overflow stamp', invalidRows.every(row => row.overflowSignal === undefined && (!row.isApiErrorMessage || row.error === 'invalid_request')) && words(invalidRows).includes('minimax-2013') && words(invalidRows).includes('invalid params'))
  mode = 'text'
  before = captures.length
  const video = await run(params('MiniMax-H3'))
  check('a model of the video line refuses before any request, naming the text road', captures.length === before && video.some(row => row.isApiErrorMessage) && words(video).includes('not on the text road'))
  const absent = await run(params('minimax-fixture-absent'))
  check('an id the account does not list refuses before inference', captures.length === before && absent.some(row => row.isApiErrorMessage) && words(absent).includes('minimax-fixture-absent'))
  modelList = []; await refreshMinimaxCatalogue({ force: true })
  const emptyPins = minimaxCatalogueRows()
  const { minimaxDisplayPin } = await import('../../src/services/providers/minimax/minimaxPins.ts')
  check('an empty live list falls to the pins labelled as pins with each row\'s own date, and a pinned id still rides under the note', emptyPins.source.kind === 'pins' && emptyPins.rows.length === 7 && emptyPins.rows.every(row => row.listedLive === false && row.observedAt === minimaxDisplayPin(row.id)?.observedAt) && keyLaneListState('minimax').kind === 'pin' && (minimaxCatalogueSourceWords() ?? '').includes('pinned list — ') && !(await run()).some(row => row.isApiErrorMessage) && captures.length === before + 1 && captures.at(-1)?.body.model === 'MiniMax-M3')
  before = captures.length
  modelList = MINIMAX_FIXTURE_MODELS
  listStatus = 299; await refreshMinimaxCatalogue({ force: true })
  const refusedList = await run()
  check("a list answered with the vendor's 1004 envelope on a 200 reads as a refused credential, and 'minimax' refuses with the key remedy", refusedList.some(row => row.isApiErrorMessage && row.error === 'authentication_failed') && words(refusedList).includes('/logins minimax') && captures.length === before)
  listStatus = 401
  const refusedLogin = await storeMinimaxApiKeyLogin('proof-key-minimax-refused-fixture-not-a-real-key')
  check('a key the list refuses is never stored and the receipt names the key page', !refusedLogin.ok && !refusedLogin.stored && refusedLogin.receipt.includes('HTTP 401') && refusedLogin.receipt.includes('platform.minimax.io') && readStoredMinimaxApiKey() === 'proof-key-minimax-payg-fixture-not-a-real-key')
  listStatus = 200
  __resetMinimaxCatalogueForTest()
  const liveBase = process.env.MERCURY_MINIMAX_API_BASE
  process.env.MERCURY_MINIMAX_API_BASE = 'http://127.0.0.1:1/v1'
  await refreshMinimaxCatalogue({ force: true })
  const pinRows = minimaxCatalogueRows()
  check('with the list unreachable the picker shows the pins, labelled as pins, each dated from the vendor pages', pinRows.source.kind === 'pins' && pinRows.rows.length === 7 && pinRows.rows.every(row => row.listedLive === false && row.observedAt === minimaxDisplayPin(row.id)?.observedAt) && keyLaneListState('minimax').kind === 'pin' && (minimaxCatalogueSourceWords() ?? '').includes('pinned list — ') && keyLanePins('minimax').every(pin => pin.liveUnknown !== true))
  process.env.MERCURY_MINIMAX_API_BASE = liveBase
  __resetMinimaxCatalogueForTest()
  const aborted = new AbortController(); aborted.abort()
  check('pre-aborted calls return quietly without a chat request', (await run({ ...params(), signal: aborted.signal })).length === 0 && captures.length === before)

  section('the control: every other lane\'s request knobs are byte-identical')
  const args = { wireModel: 'fixture-model', effortValue: 'high', thinkingEnabled: true, maxOutputTokensOverride: 256 }
  const anthropicOut: Record<string, unknown> = {}
  configureEffortParams('high', anthropicOut as never, {}, 'claude-opus-5-5')
  check('Anthropic, OpenAI and Z.AI', JSON.stringify(anthropicOut) === '{"effort":"high"}' && JSON.stringify(buildOpenaiResponsesRequest({ model: 'gpt-6-astra', instructions: 'sys', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high', promptCacheKey: 'sess-1' })) === '{"model":"gpt-6-astra","instructions":"sys","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"reasoning":{"effort":"high","summary":"auto"},"store":false,"stream":true,"include":["reasoning.encrypted_content"],"prompt_cache_key":"sess-1"}' && JSON.stringify(buildZaiChatRequest({ model: 'glm-5.3', system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256, reasoningEffort: 'high', thinkingEnabled: true })) === '{"model":"glm-5.3","messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"}],"max_tokens":256,"reasoning_effort":"high","thinking":{"type":"enabled"}}')
  check('Mistral, Meta and Nous', JSON.stringify(buildMistralExtras({ ...args, wireModel: 'mistral-large-4' })) === '{"reasoning_effort":"high","max_tokens":256}' && JSON.stringify(buildMetaExtras({ ...args, wireModel: 'muse-spark-1.3' })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}' && JSON.stringify(nousLaneProfile.buildExtras({ ...args, wireModel: 'anthropic/claude-sonnet-4.6' })) === '{"stream_options":{"include_usage":true},"max_tokens":256}')
  check('OpenCode Zen', JSON.stringify(buildZenExtras({ ...args, wireModel: 'glm-5.3' })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}')
  check('Moonshot', JSON.stringify(buildMoonshotExtras({ ...args, wireModel: 'kimi-k3' })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}')
  check('DeepSeek', JSON.stringify(buildDeepseekExtras({ ...args, wireModel: 'deepseek-v4-pro' })) === '{"thinking":{"type":"enabled"},"reasoning_effort":"high","stream_options":{"include_usage":true},"max_tokens":256}')
  check('OpenRouter', JSON.stringify(buildOpenrouterExtras({ ...args, vocabulary: ['low', 'high'] })) === '{"stream_options":{"include_usage":true},"reasoning":{"effort":"high"},"max_tokens":256}')
  check('xAI', JSON.stringify(buildXaiExtras({ ...args, vocabulary: ['low', 'high'] })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}')
  check('the compat slot, Hugging Face, Gemini and local', JSON.stringify(buildCompatSlotExtras(args)) === '{"stream_options":{"include_usage":true},"max_tokens":256}' && JSON.stringify(buildHuggingfaceExtras(args)) === '{"stream_options":{"include_usage":true},"max_tokens":256}' && JSON.stringify(buildGeminiExtras({ ...args, acceptsEffort: true })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_tokens":256}' && JSON.stringify(buildLocalExtras({ ...args, server: 'ollama', acceptsEffort: true })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_tokens":256}')
  console.log(`MINIMAX WIRE GREEN (${count} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
