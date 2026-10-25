import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import { COHERE_FIXTURE_MODELS } from '../providers/lib/openweights-fixture.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BUSY_RETRY_SCALE = '0.2'
process.env.COHERE_API_KEY = 'proof-key-cohere-wire-fixture-not-a-real-key'
type Mode = 'text' | 'tools' | 'malformed' | 'auth' | 'billing' | 'busy' | 'rate' | 'truncated' | 'invalid' | 'misplaced'
let mode: Mode = 'text'
let modelList: unknown[] = COHERE_FIXTURE_MODELS
let listStatus = 200
const captures: Array<{ path: string; body: Record<string, any>; bearer: boolean }> = []
let listReads = 0
const sse = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const bearer = req.headers.get('authorization') === `Bearer ${process.env.COHERE_API_KEY}`
  if (path === '/compatibility/v1/models') {
    listReads++
    if (listStatus === 401) return Response.json({ message: 'invalid api token' }, { status: 401 })
    if (listStatus === 500) return new Response('upstream unavailable', { status: 500 })
    return Response.json({ object: 'list', data: modelList })
  }
  assert.equal(path, '/compatibility/v1/chat/completions')
  assert.equal(req.method, 'POST')
  const raw = await req.text()
  assert.ok(!raw.includes(process.env.COHERE_API_KEY!))
  const body = JSON.parse(raw)
  captures.push({ path, body, bearer })
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== 'none' && body.reasoning_effort !== 'high') return Response.json({ message: `reasoning_effort '${body.reasoning_effort}' is not supported; only none and high are supported` }, { status: 400 })
  if ('parallel_tool_calls' in body || 'stream_options' in body) return Response.json({ message: 'unsupported parameter' }, { status: 400 })
  if (mode === 'auth') return Response.json({ message: 'invalid api token' }, { status: 401 })
  if (mode === 'billing') return Response.json({ message: 'Your account has no remaining credits.' }, { status: 402 })
  if (mode === 'rate') return Response.json({ message: 'You are using a Trial key, which is limited to 10 API calls / minute.' }, { status: 429, headers: { 'retry-after': '3600' } })
  if (mode === 'busy') { mode = 'text'; return Response.json({ message: 'Service unavailable' }, { status: 503 }) }
  if (mode === 'invalid') return Response.json({ message: 'invalid request: unknown field' }, { status: 400 })
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown, extra: Record<string, unknown> = {}): string => sse({ id: 'cohere-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish, ...extra }], ...(usage ? { usage } : {}) })
  let stream = chunk({ role: 'assistant', content: '' })
  if (mode === 'tools' || mode === 'malformed') {
    stream += chunk({ tool_calls: [{ index: 0, id: 'call_fixture_1', type: 'function', function: { name: 'FixtureEcho', arguments: mode === 'malformed' ? '{broken' : '{"text":' } }] })
    if (mode === 'tools') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] })
    stream += chunk({}, 'tool_calls', { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 })
  } else {
    if (mode === 'misplaced') stream += chunk({ content: 'COHERE-' }, null, undefined, { reasoning_content: 'misplaced on the choice' })
    else if (body.reasoning_effort === 'high') {
      stream += chunk({ reasoning_content: 'Weighing the fixture' })
      stream += chunk({ reasoning_content: ' carefully.', content: 'COHERE-' })
    } else stream += chunk({ content: 'COHERE-' })
    stream += chunk({ content: 'FIXTURE-SETTLED' })
    if (mode !== 'truncated') stream += chunk({}, 'stop', { prompt_tokens: 32, completion_tokens: 103, total_tokens: 135 })
  }
  if (mode === 'truncated') return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  return new Response(stream + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MERCURY_COHERE_API_BASE = `http://127.0.0.1:${server.port}/compatibility/v1`
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
const { refreshCohereCatalogue, __resetCohereCatalogueForTest, cohereCatalogueRows, cohereCatalogueSourceWords } = await import('../../src/services/providers/cohere/cohereCatalogue.ts')
const { buildCohereExtras } = await import('../../src/services/providers/cohere/cohereCallModel.ts')
const { storeCohereApiKeyLogin } = await import('../../src/services/providers/cohere/cohereLogin.ts')
const { usageForProvider } = await import('../../src/services/providers/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
const { classifyModelRoute } = await import('../../src/services/providers/routeLaw.ts')
const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
const { keyLaneListState, keyLanePins } = await import('../../src/utils/model/modelOptions.ts')
const { readStoredCohereApiKey } = await import('../../src/services/providers/providerSecrets.ts')
const { modelSupportsThinking, effortVocabularyFor, resolveContextWindow } = await import('../../src/utils/model/capabilities.ts')
const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
function params(model = 'cohere', effortValue: string | undefined = 'max', thinking = true, messages: Message[] = [createUserMessage({ content: 'hello fixture' })]): CompatCallModelParams {
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
  check('the three bare prefixes and the family word route to Cohere and nowhere else', ['command-a-plus-05-2026', 'north-mini-code-1-0', 'c4ai-aya-expanse-32b', 'command-r-08-2024', 'cohere'].every(id => classifyModelRoute(parseUserSpecifiedModel(id)).route === 'cohere') && classifyModelRoute(parseUserSpecifiedModel('openrouter/cohere/command-a')).route === 'openrouter')
  check('the key configures a Cohere backend but is not a claimed live turn', resolvePrimaryAgentBackend('command-a-plus-05-2026')?.id === 'cohere-chat' && resolvePrimaryAgentBackend('cohere')?.readiness().state === 'configured' && resolveProviderUsability().cohere.usable)

  section('the wire')
  const first = await run()
  const body = captures[0]!.body
  check('the family word reads the account list once and selects Command A+, the first served pin', listReads === 1 && body.model === 'command-a-plus-05-2026' && captures[0]?.bearer)
  check('the request streams with function tools and auto choice, and sends neither stream_options nor parallel_tool_calls (the vendor lists the latter unsupported)', body.stream === true && !('stream_options' in body) && !('parallel_tool_calls' in body) && body.tools[0].function.name === 'FixtureEcho' && body.tool_choice === 'auto')
  check("thinking on sends reasoning_effort 'high', one of the two words the vendor accepts, and no foreign thinking field", body.reasoning_effort === 'high' && !('thinking' in body) && !('reasoning' in body))
  check('an explicit output override rides max_tokens; sampling stays at the provider defaults', body.max_tokens === 512 && !('max_completion_tokens' in body) && !('temperature' in body))
  check('reasoning_content deltas become one thinking block and the visible text keeps every byte', thinkingOf(first) === 'Weighing the fixture carefully.' && textOf(first) === 'COHERE-FIXTURE-SETTLED')
  const usage = first.at(-1)?.message.usage
  check('the usage on the final chunk settles once', usage?.input_tokens === 32 && usage.output_tokens === 103)
  check('a settled turn alone advances the readiness receipt', resolvePrimaryAgentBackend('cohere')?.readiness().state === 'ready')
  const off = await run(params('command-a-plus-05-2026', 'max', false))
  check("thinking off sends reasoning_effort 'none' and the reply carries no thinking block", captures.at(-1)?.body.reasoning_effort === 'none' && thinkingOf(off) === '' && textOf(off) === 'COHERE-FIXTURE-SETTLED')
  await run(params('north-mini-code-1-0', 'low', true))
  check("every thinking-on effort rung is the same vendor word on a two-word dial — 'low' and 'medium' are never sent (the vendor answers them with HTTP 400)", captures.at(-1)?.body.reasoning_effort === 'high' && captures.at(-1)?.body.model === 'north-mini-code-1-0')
  await run(params('command-a-03-2025', 'max', true))
  check('a row the vendor lists without reasoning sends no reasoning_effort at all', !('reasoning_effort' in captures.at(-1)!.body) && captures.at(-1)?.body.model === 'command-a-03-2025')
  await run(params('Command-A-Plus-05-2026', 'high', true))
  check('an id typed in another case dispatches as the listed row the vendor spells', captures.at(-1)?.body.model === 'command-a-plus-05-2026')
  check('unknown model facts invent neither an effort nor an output ceiling', JSON.stringify(buildCohereExtras({ wireModel: 'command-fixture-unknown', effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: undefined })) === '{}')
  const structured = params('command-a-plus-05-2026')
  structured.options.outputFormat = { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }
  await run(structured)
  check("structured output uses the vendor's json_object shape with the schema beside it, never json_schema", captures.at(-1)?.body.response_format.type === 'json_object' && JSON.stringify(captures.at(-1)?.body.response_format.schema) === JSON.stringify(structured.options.outputFormat.schema) && !('json_schema' in captures.at(-1)!.body.response_format))
  mode = 'tools'
  const tools = await run(params('command-a-plus-05-2026'))
  const calls = tools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use')
  check('fragmented tool arguments become one validated executable call under the provider id', calls.length === 1 && calls[0]?.type === 'tool_use' && calls[0].id === 'call_fixture_1' && JSON.stringify(calls[0].input) === '{"text":"hello"}')
  mode = 'text'
  await run(params('command-a-plus-05-2026', 'high', true, [...tools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_fixture_1', content: 'echo:hello' }] })]))
  const history = captures.at(-1)!.body.messages
  check('tool results replay with the matching assistant call and no private reasoning', history.some((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'call_fixture_1') && history.some((row: any) => row.role === 'tool' && row.tool_call_id === 'call_fixture_1') && history.every((row: any) => !('reasoning_content' in row)))
  const dispatch = await resolveEngineDispatch('cohere')
  check("the Agent class word 'cohere' selects the same served Command A+ row", dispatch?.backend === 'cohere' && dispatch.model === 'command-a-plus-05-2026')
  check('the capability reads follow the pins: Command A+ thinks with the two-word vocabulary, Command A does not, the windows are the stated ones', modelSupportsThinking('command-a-plus-05-2026') && !modelSupportsThinking('command-a-03-2025') && JSON.stringify(effortVocabularyFor('north-mini-code-1-0')).includes('"vocabulary":["none","high"]') && resolveContextWindow('north-mini-code-1-0').effectiveWindow === 256_000)

  section('the catalogue and the login')
  const rows = cohereCatalogueRows()
  check('the picker lists the chat rows only, pinned first, with embed and rerank set aside', rows.source.kind === 'live' && rows.rows.length === 6 && rows.rows[0]?.id === 'command-a-plus-05-2026' && !rows.rows.some(row => row.id.startsWith('embed') || row.id.startsWith('rerank')))
  const stored = await storeCohereApiKeyLogin('proof-key-cohere-login-fixture-not-a-real-key')
  check('a key the list accepts is stored with the chat count in the receipt', stored.ok && stored.stored && readStoredCohereApiKey() === 'proof-key-cohere-login-fixture-not-a-real-key' && stored.receipt.includes('6 chat models listed') && stored.receipt.includes('COHERE_API_KEY is set and wins'))
  const view = usageForProvider('cohere')
  check('/usage names the session spend and the dashboard; no meter is invented', view.sourceKind === 'api-key' && view.windows.length === 0 && view.credits.state === 'unreported' && (view.absence ?? '').includes('dashboard.cohere.com'))

  section('refusals')
  mode = 'auth'
  let before = captures.length
  const auth = await run(params('command-a-plus-05-2026'))
  check('a key the vendor refuses with HTTP 401 refuses once with the Cohere remedy, never a hop', captures.length === before + 1 && auth.some(row => row.isApiErrorMessage && row.error === 'authentication_failed') && words(auth).includes('/logins cohere'))
  mode = 'billing'
  before = captures.length
  const billing = await run(params('command-a-plus-05-2026'))
  check('a 402 is a billing refusal that belongs to Cohere alone', captures.length === before + 1 && billing.some(row => row.isApiErrorMessage && row.error === 'billing_error') && laneBillingState('cohere').state === 'credit-exhausted' && laneBillingState('together').state === 'clear')
  mode = 'rate'
  before = captures.length
  const rate = await run(params('command-a-plus-05-2026'))
  check("a 429 with the vendor's retry-after names the wait and stays on the lane: one request, no hop", captures.length === before + 1 && rate.some(row => row.isApiErrorMessage && row.error === 'rate_limit') && words(rate).includes('asks for a 1h wait') && words(rate).includes('Trial key'))
  mode = 'busy'
  before = captures.length
  await run(params('command-a-plus-05-2026'))
  check('a provider overload retries its own lane then clears its billing state', captures.length === before + 2 && laneBillingState('cohere').state === 'clear')
  mode = 'text'
  await run(params('command-a-reasoning-08-2025', 'medium', true))
  check("an effort word the family lacks ('medium') is clamped to the vendor's word ('high'), never a 400", captures.at(-1)?.body.reasoning_effort === 'high' && captures.at(-1)?.body.model === 'command-a-reasoning-08-2025')
  mode = 'misplaced'
  const misplaced = await run(params('command-a-plus-05-2026'))
  check('a reasoning field in the wrong place (on the choice, not the delta) is ignored: no invented thinking, the text intact, the turn settled', thinkingOf(misplaced) === '' && textOf(misplaced) === 'COHERE-FIXTURE-SETTLED' && !misplaced.some(row => row.isApiErrorMessage))
  mode = 'malformed'
  check('malformed tool JSON cannot become an executable call', !(await run(params('command-a-plus-05-2026'))).some(row => row.message.content.some(block => block.type === 'tool_use')))
  mode = 'truncated'
  check('an unterminated stream does not count as success', (await run(params('command-a-plus-05-2026'))).some(row => row.isApiErrorMessage))
  mode = 'invalid'
  check('a vendor 400 settles as a typed refusal without an overflow stamp', (await run(params('command-a-plus-05-2026'))).every(row => row.overflowSignal === undefined && (!row.isApiErrorMessage || row.error === 'invalid_request')))
  mode = 'text'
  before = captures.length
  const embed = await run(params('embed-v4.0'))
  check('an embedding id is not a chat id: it refuses before any request', captures.length === before && embed.some(row => row.isApiErrorMessage))
  const absent = await run(params('command-fixture-absent'))
  check('an id the account does not list refuses before inference', captures.length === before && absent.some(row => row.isApiErrorMessage) && words(absent).includes('command-fixture-absent'))
  modelList = []; await refreshCohereCatalogue({ force: true })
  const emptyPins = cohereCatalogueRows()
  check('an empty live list falls to the 15 pins labelled as pins (nine observed 2026-10-17, the six Tiny Aya and translate rows 2026-10-25), and a pinned id still rides under the note', emptyPins.source.kind === 'pins' && emptyPins.rows.length === 15 && emptyPins.rows.every(row => row.listedLive === false) && emptyPins.rows.filter(row => row.observedAt === '2026-10-17').length === 9 && emptyPins.rows.filter(row => row.observedAt === '2026-10-25').length === 6 && keyLaneListState('cohere').kind === 'pin' && (cohereCatalogueSourceWords() ?? '').includes('pinned list (observed 2026-10-17)') && !(await run()).some(row => row.isApiErrorMessage) && captures.length === before + 1 && captures.at(-1)?.body.model === 'command-a-plus-05-2026')
  before = captures.length
  modelList = COHERE_FIXTURE_MODELS
  listStatus = 401; __resetCohereCatalogueForTest(); await refreshCohereCatalogue({ force: true })
  const refusedList = await run()
  check("a refused list is an auth refusal with the key remedy even when 'cohere' has no row", refusedList.some(row => row.isApiErrorMessage && row.error === 'authentication_failed') && words(refusedList).includes('/logins cohere') && captures.length === before)
  const refusedLogin = await storeCohereApiKeyLogin('proof-key-cohere-refused-fixture-not-a-real-key')
  check('a key the list refuses is never stored and the receipt names the key page', !refusedLogin.ok && !refusedLogin.stored && refusedLogin.receipt.includes('HTTP 401') && refusedLogin.receipt.includes('dashboard.cohere.com/api-keys') && readStoredCohereApiKey() === 'proof-key-cohere-login-fixture-not-a-real-key')
  listStatus = 500; __resetCohereCatalogueForTest(); await refreshCohereCatalogue({ force: true })
  const pinRows = cohereCatalogueRows()
  check('with the list unreachable the picker shows the 15 pins, labelled as pins, dated from the vendor pages', pinRows.source.kind === 'pins' && pinRows.rows.length === 15 && pinRows.rows.every(row => row.listedLive === false && (row.observedAt === '2026-10-17' || row.observedAt === '2026-10-25')) && keyLaneListState('cohere').kind === 'pin' && (cohereCatalogueSourceWords() ?? '').includes('pinned list (observed 2026-10-17)') && keyLanePins('cohere').every(pin => pin.liveUnknown !== true))
  before = captures.length
  const unreachableTurn = await run(params('command-r-08-2024'))
  check('with the list unreachable a pinned id still rides, with the note that the provider decides', captures.length === before + 1 && captures.at(-1)?.body.model === 'command-r-08-2024' && textOf(unreachableTurn).startsWith('Cohere model list unavailable') && textOf(unreachableTurn).endsWith('COHERE-FIXTURE-SETTLED'))
  listStatus = 200; __resetCohereCatalogueForTest()
  const aborted = new AbortController(); aborted.abort()
  check('pre-aborted calls return quietly without a chat request', (await run({ ...params(), signal: aborted.signal })).length === 0 && captures.length === before + 1)
  console.log(`COHERE WIRE GREEN (${count} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
