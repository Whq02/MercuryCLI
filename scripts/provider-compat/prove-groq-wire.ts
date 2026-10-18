import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'ANTHROPIC_BASE_URL']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BUSY_RETRY_SCALE = '0.2'
process.env.GROQ_API_KEY = 'proof-key-groq-wire-fixture-not-a-real-key'
const fixtures = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'minimaxai/minimax-m2.7', 'meta-models/muse-spark-open', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'fixture-new-chat', 'whisper-large-v3', 'canopylabs/orpheus-v1-english', 'meta-llama/llama-prompt-guard-2-86m', 'openai/gpt-oss-safeguard-20b'].map(id => ({ id, object: 'model', created: 1, owned_by: 'fixture', active: true, context_window: 131072 }))
let modelList = fixtures
let listStatus = 200
let mode = 'text'
let listReads = 0
const captures: Array<{ path: string; body: Record<string, any>; bearer: boolean }> = []
const rates = { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '900', 'x-ratelimit-reset-requests': '2m59.56s', 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '6000', 'x-ratelimit-reset-tokens': '7.66s' }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (path === '/openai/v1/models') {
    listReads++
    return Response.json(listStatus === 200 ? { object: 'list', data: modelList } : { error: { message: 'invalid api key', code: 'invalid_api_key' } }, { status: listStatus })
  }
  assert.equal(path, '/openai/v1/chat/completions')
  assert.equal(req.method, 'POST')
  const body = await req.json() as Record<string, any>
  captures.push({ path, body, bearer: req.headers.get('authorization') === `Bearer ${process.env.GROQ_API_KEY}` })
  const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) => Response.json({ error: { message, type: 'invalid_request_error', code } }, { status, headers })
  if ('max_tokens' in body || 'reasoning' in body || 'thinking' in body || body.messages.some((row: any) => 'reasoning_content' in row)) return fail(400, 'invalid_request_error', 'unsupported property')
  if (body.model.startsWith('openai/gpt-oss-') && ('reasoning_format' in body || !['low', 'medium', 'high'].includes(body.reasoning_effort ?? 'medium'))) return fail(400, 'invalid_request_error', 'unsupported reasoning control')
  if (['qwen/qwen3.8-27b', 'minimaxai/minimax-m2.7', 'meta-models/muse-spark-open'].includes(body.model) && body.reasoning_format !== 'parsed') return fail(400, 'invalid_request_error', 'raw reasoning with tools')
  if (mode === 'auth') return fail(401, 'invalid_api_key', 'invalid api key')
  if (mode === 'billing') return fail(400, 'blocked_api_access', 'organization monthly spend limit reached')
  if (mode === 'rate') return fail(429, 'rate_limit_exceeded', 'tokens per minute reached', { ...rates, 'retry-after': '3600' })
  if (mode === 'header-rate') return fail(429, 'rate_limit_exceeded', 'tokens per minute reached', { ...rates, 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '1h' })
  if (mode === 'busy') { mode = 'text'; return fail(503, 'server_error', 'service unavailable') }
  const chunk = (delta: unknown, finish: string | null = null, extra = {}) => `data: ${JSON.stringify({ id: 'groq-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish, ...(mode === 'misplaced' ? { reasoning: 'wrong place' } : {}) }], ...extra })}\n\n`
  let stream = chunk({ role: 'assistant', content: '' })
  if (mode === 'tools' || mode === 'malformed') {
    stream += chunk({ reasoning: 'Calling the fixture.' })
    stream += chunk({ tool_calls: [{ index: 0, id: 'call_fixture_1', type: 'function', function: { name: 'FixtureEcho', arguments: mode === 'malformed' ? '{broken' : '{"text":' } }] })
    if (mode === 'tools') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] })
    stream += chunk({}, 'tool_calls')
  } else {
    if (mode !== 'misplaced' && body.reasoning_effort !== 'none') stream += chunk({ reasoning: 'Reasoning in the delta.' })
    stream += chunk({ content: 'GROQ-FIXTURE-SETTLED' })
    if (mode !== 'truncated') stream += chunk({}, 'stop')
  }
  if (mode !== 'truncated') stream += chunk({}, null, { usage: { prompt_tokens: 32, completion_tokens: 103, total_tokens: 135, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 9 } } }) + 'data: [DONE]\n\n'
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', ...rates } })
} })
process.env.MERCURY_GROQ_API_BASE = `http://127.0.0.1:${server.port}/openai/v1`
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  const { classifyModelRoute } = await import('../../src/services/providers/routeLaw.ts')
  check('Groq qualified ids are declared before any inference request', classifyModelRoute('groq/openai/gpt-oss-120b').route === 'groq')
  const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
  const { refreshGroqCatalogue, __resetGroqCatalogueForTest, groqCatalogueRows, groqCatalogueSourceWords } = await import(new URL('../../src/services/providers/groq/groqCatalogue.ts', import.meta.url).href)
  const { buildGroqExtras, groqCallModel } = await import(new URL('../../src/services/providers/groq/groqCallModel.ts', import.meta.url).href)
  const { storeGroqApiKeyLogin } = await import(new URL('../../src/services/providers/groq/groqLogin.ts', import.meta.url).href)
  const { groqObservedLimits } = await import(new URL('../../src/services/providers/groq/groqUsageState.ts', import.meta.url).href)
  const { usageForProvider } = await import('../../src/services/providers/providerUsage.ts')
  const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
  const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
  const { keyLaneListState, keyLanePins } = await import('../../src/utils/model/modelOptions.ts')
  const { readStoredGroqApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { liveModelsReference, knownModelsReference } = await import('../../src/services/resources/adapters/models.ts')
  const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
  function params(model = 'groq/openai/gpt-oss-120b', effortValue = 'max', thinking = true, messages: Message[] = [createUserMessage({ content: 'hello fixture' })]): CompatCallModelParams {
    return { messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: thinking ? { type: 'enabled', budgetTokens: 4096 } : { type: 'disabled' }, signal: new AbortController().signal,
      options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue } as never }
  }
  async function run(p = params(), direct = false): Promise<AssistantMessage[]> {
    const settled: AssistantMessage[] = []
    for await (const event of (direct ? groqCallModel(p) : routedCallModel(p as never))) if (event.type === 'assistant') settled.push(event as AssistantMessage)
    return settled
  }
  const textOf = (rows: AssistantMessage[]): string => rows.flatMap(row => row.message.content).map(block => block.type === 'text' ? block.text : '').join('')
  const thinkingOf = (rows: AssistantMessage[]): string => rows.flatMap(row => row.message.content).map(block => block.type === 'thinking' ? block.thinking : '').join('')
  const words = (rows: AssistantMessage[]): string => rows.filter(row => row.isApiErrorMessage).map(row => JSON.stringify(row.message.content)).join(' ')
  check('a bare GPT OSS id keeps OpenAI ownership and a bare vendor slug is not Groq', classifyModelRoute('gpt-oss-120b').route === 'openai' && classifyModelRoute('qwen/qwen3.8-27b').kind === 'unrecognised')
  check('a key is configured, not yet a proven turn', resolvePrimaryAgentBackend('groq/openai/gpt-oss-120b')?.readiness().state === 'configured')
  const first = await run()
  const body = captures[0]!.body
  check('the account list is read once and the bearer and wire id belong to Groq', listReads === 1 && captures[0]?.bearer && body.model === 'openai/gpt-oss-120b')
  check('the OSS wire carries function tools, streaming usage, included reasoning, high effort and its full output limit', body.tools[0].function.name === 'FixtureEcho' && body.tool_choice === 'auto' && body.stream_options.include_usage && body.stream && body.include_reasoning === true && body.reasoning_effort === 'high' && body.max_completion_tokens === 65536 && !('reasoning_format' in body) && !('max_tokens' in body))
  check('text, reasoning and disjoint usage settle from the final stream', textOf(first) === 'GROQ-FIXTURE-SETTLED' && thinkingOf(first) === 'Reasoning in the delta.' && first.at(-1)?.message.usage.input_tokens === 28 && first.at(-1)?.message.usage.cache_read_input_tokens === 4 && first.at(-1)?.message.usage.output_tokens === 103)
  check('readiness advances only after settlement', resolvePrimaryAgentBackend('groq/openai/gpt-oss-120b')?.readiness().state === 'ready')
  await run(params('groq/qwen/qwen3.8-27b'))
  check('Qwen uses parsed reasoning, high effort and its own output max', captures.at(-1)?.body.reasoning_format === 'parsed' && captures.at(-1)?.body.reasoning_effort === 'high' && captures.at(-1)?.body.max_completion_tokens === 16384 && !('include_reasoning' in captures.at(-1)!.body))
  await run(params('groq/meta-models/muse-spark-open'))
  check('Muse max means its highest rung xhigh', captures.at(-1)?.body.reasoning_effort === 'xhigh' && captures.at(-1)?.body.max_completion_tokens === 131072)
  const meter = usageForProvider('groq')
  check('rate headers paint RPD and TPM without inventing a balance', meter.windows.length === 2 && meter.windows[1]?.usedPct === 25 && meter.figures?.[0]?.value.includes('900 remaining') && meter.credits?.state === 'unreported')
  mode = 'tools'; const tools = await run()
  check('fragmented tool JSON produces one validated call with the vendor id', tools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use').length === 1)
  mode = 'text'; await run(params(undefined, 'high', true, [...tools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_fixture_1', content: 'hello' }] })]))
  const history = captures.at(-1)!.body.messages
  check('tool/result identity survives replay and Groq never receives historical reasoning_content', history.some((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'call_fixture_1') && history.some((row: any) => row.role === 'tool' && row.tool_call_id === 'call_fixture_1') && history.every((row: any) => !('reasoning_content' in row)))
  check('the picker filters speech and guard rows and qualifies every text row', groqCatalogueRows().rows.length === 8 && keyLanePins('groq').every(pin => pin.id.startsWith('groq/')))
  check('Agent exact dispatch keeps the qualified model', (await resolveEngineDispatch('groq/openai/gpt-oss-120b'))?.model === 'groq/openai/gpt-oss-120b')
  check('the Agent family selector resolves to a qualified row without declaring a bare Groq model id', classifyModelRoute('groq').kind === 'unrecognised' && (await resolveEngineDispatch('groq'))?.model === 'groq/openai/gpt-oss-120b')
  check('the live resource and known resource both carry Groq models', (await liveModelsReference({ engineModel: 'groq/openai/gpt-oss-120b' })).providers.find(row => row.provider === 'groq')?.models.length === 8 && (await knownModelsReference()).providers.find(row => row.provider === 'groq')?.models.length === 7 && (await knownModelsReference()).providers.find(row => row.provider === 'groq')?.familyWord === 'groq')
  const login = await storeGroqApiKeyLogin('proof-key-groq-login-fixture-not-a-real-key')
  check('the accepted key is stored with the environment-precedence receipt', login.ok && login.stored && readStoredGroqApiKey() === 'proof-key-groq-login-fixture-not-a-real-key' && login.receipt.includes('GROQ_API_KEY is set and wins'))
  console.log('\nrefusals')
  for (const [testMode, typed, needle] of [['auth', 'authentication_failed', '/logins groq'], ['billing', 'billing_error', 'blocked_api_access'], ['rate', 'rate_limit', 'asks for a 1h wait'], ['header-rate', 'rate_limit', 'asks for a 1h wait']]) {
    mode = testMode!; const before = captures.length; const rows = await run()
    check(`${testMode} stays on Groq, refuses once and names the remedy or wait`, captures.length === before + 1 && rows.some(row => row.error === typed) && words(rows).includes(needle!))
    console.log(words(rows))
    if (testMode === 'billing') check('the billing observation belongs to Groq alone', laneBillingState('groq').state === 'credit-exhausted' && laneBillingState('mistral').state === 'clear')
  }
  mode = 'busy'; const beforeRetry = captures.length; await run()
  check('an overload retries Groq and a served turn clears the refusal', captures.length === beforeRetry + 2 && laneBillingState('groq').state === 'clear')
  mode = 'text'; await run(params(undefined, 'minimal'))
  check('unsupported minimal maps to the lowest served OSS rung, not a 400', captures.at(-1)?.body.reasoning_effort === 'low')
  await run(params(undefined, 'max', false))
  check('OSS thinking off uses low rather than the unsupported none word', captures.at(-1)?.body.reasoning_effort === 'low')
  await run(params('groq/qwen/qwen3.8-27b', 'max', false))
  check('Qwen thinking off sends its documented none word', captures.at(-1)?.body.reasoning_effort === 'none')
  mode = 'misplaced'; const misplaced = await run()
  check('a reasoning field on the choice rather than its delta is ignored', thinkingOf(misplaced) === '' && textOf(misplaced) === 'GROQ-FIXTURE-SETTLED')
  mode = 'malformed'; check('malformed tool JSON is never executable', !(await run()).some(row => row.message.content.some(block => block.type === 'tool_use')))
  mode = 'truncated'; check('missing terminal data remains a visible fault beside partial text', (await run()).some(row => row.isApiErrorMessage))
  mode = 'text'; const beforeAbsent = captures.length
  for (const id of ['groq/missing-fixture', 'groq/whisper-large-v3', 'groq/canopylabs/orpheus-v1-english', 'groq/meta-llama/llama-prompt-guard-2-86m', 'groq/openai/gpt-oss-safeguard-20b', 'groq/', 'groq/groq/foo', 'openai/gpt-oss-120b']) {
    const refused = await run(params(id), true)
    check(`unserved or unqualified id refuses before inference: ${id}`, captures.length === beforeAbsent && refused.some(row => row.error === 'invalid_request'))
    console.log(words(refused))
  }
  listStatus = 401
  const refusedLogin = await storeGroqApiKeyLogin('proof-key-groq-refused-fixture-not-a-real-key')
  check('a refused login never overwrites the stored key', !refusedLogin.stored && refusedLogin.receipt.includes('HTTP 401') && readStoredGroqApiKey() === 'proof-key-groq-login-fixture-not-a-real-key')
  listStatus = 200; modelList = []; await refreshGroqCatalogue({ force: true })
  const emptyBefore = captures.length
  check('an empty live list falls to the 7 dated pins labelled as pins, admits a pinned id under the note, and refuses an unpinned id', groqCatalogueRows().source.kind === 'pins' && groqCatalogueRows().rows.length === 7 && groqCatalogueRows().rows.every((row: any) => !row.listedLive && row.observedAt === '2026-10-18') && keyLaneListState('groq').kind === 'pin' && (groqCatalogueSourceWords() ?? '').includes('pinned list (observed 2026-10-18)') && !(await run()).some(row => row.isApiErrorMessage) && captures.length === emptyBefore + 1 && (await run(params('groq/missing-fixture'))).some(row => row.isApiErrorMessage) && captures.length === emptyBefore + 1)
  const beforeUnreachable = captures.length
  modelList = fixtures; __resetGroqCatalogueForTest(); const base = process.env.MERCURY_GROQ_API_BASE
  process.env.MERCURY_GROQ_API_BASE = 'http://127.0.0.1:1/openai/v1'
  await refreshGroqCatalogue({ force: true })
  check('unreachable catalogue falls back to dated, explicitly labelled pins', groqCatalogueRows().source.kind === 'pins' && keyLaneListState('groq').kind === 'pin' && groqCatalogueRows().rows.every((row: any) => !row.listedLive && row.observedAt === '2026-10-18') && groqCatalogueSourceWords().includes('pinned list'))
  check('rate observations cannot leak onto another endpoint', groqObservedLimits() === null)
  process.env.MERCURY_GROQ_API_BASE = base
  const controller = new AbortController(); controller.abort()
  check('pre-aborted calls perform no inference', (await run({ ...params(), signal: controller.signal })).length === 0 && captures.length === beforeUnreachable)
  check('unknown rows get no invented reasoning field or output ceiling', JSON.stringify(buildGroqExtras({ wireModel: 'fixture-new-chat', effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: undefined })) === '{"stream_options":{"include_usage":true}}')
  const { proveExistingCompatKnobs } = await import('../providers/lib/fast-infer-control.ts')
  await proveExistingCompatKnobs()
  console.log(`GROQ WIRE GREEN (${count} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
