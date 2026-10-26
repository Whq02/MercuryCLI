import '../lib/hermetic.ts'
import { assertRefusedCallResult } from '../providers/lib/refused-call-result.ts'
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
process.env.FIREWORKS_API_KEY = 'proof-key-fireworks-wire-fixture-not-a-real-key'
const fixtures = ['accounts/fireworks/models/kimi-k3', 'accounts/fireworks/models/gpt-oss-120b', 'accounts/fireworks/models/qwen3p8-max', 'accounts/fireworks/models/fixture-new-chat', 'accounts/fireworks/models/flux-fixture', 'accounts/fireworks/routers/kimi-fast-latest'].map(id => ({ id, object: 'model', created: 1, owned_by: 'fireworks' }))
let modelList = fixtures
let listStatus = 200
let mode = 'text'
let listReads = 0
const captures: Array<{ path: string; body: Record<string, any>; bearer: boolean; affinity: string | null }> = []
const rates = { 'X-Ratelimit-Limit-Tokens-Prompt': '10000', 'X-Ratelimit-Limit-Tokens-Cache-Adjusted-Prompt': '5000', 'X-Ratelimit-Limit-Tokens-Generated': '2000' }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (path === '/inference/v1/models') {
    listReads++
    return Response.json(listStatus === 200 ? { object: 'list', data: modelList } : { error: { message: 'invalid api key', code: 'invalid_api_key' } }, { status: listStatus })
  }
  assert.equal(path, '/inference/v1/chat/completions')
  assert.equal(req.method, 'POST')
  const body = await req.json() as Record<string, any>
  captures.push({ path, body, bearer: req.headers.get('authorization') === `Bearer ${process.env.FIREWORKS_API_KEY}`, affinity: req.headers.get('x-session-affinity') })
  const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) => Response.json({ error: { message, type: 'invalid_request_error', code } }, { status, headers })
  if ('max_completion_tokens' in body || 'reasoning' in body || 'thinking' in body) return fail(400, 'invalid_request_error', 'unsupported reasoning control')
  if (body.model === 'accounts/fireworks/models/gpt-oss-120b' && !['low', 'medium', 'high'].includes(body.reasoning_effort ?? 'medium')) return fail(400, 'invalid_request_error', 'unsupported effort')
  if (!body.model.startsWith('accounts/fireworks/')) return fail(400, 'invalid_request_error', 'full resource id required')
  if (!req.headers.get('x-session-affinity')) return fail(400, 'invalid_request_error', 'session affinity absent')
  if (mode === 'auth') return fail(401, 'invalid_api_key', 'invalid api key')
  if (mode === 'billing') return fail(402, 'payment_required', 'payment required')
  if (mode === 'rate') return fail(429, 'rate_limit_exceeded', 'tokens per minute reached', { ...rates, 'retry-after': '3600' })
  if (mode === 'busy') { mode = 'text'; return fail(503, 'server_error', 'service unavailable') }
  const chunk = (delta: unknown, finish: string | null = null, extra = {}) => `data: ${JSON.stringify({ id: 'fireworks-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish, ...(mode === 'misplaced' ? { reasoning: 'wrong place' } : {}) }], ...extra })}\n\n`
  let stream = chunk({ role: 'assistant', content: '' })
  if (mode === 'tools' || mode === 'malformed') {
    stream += chunk({ reasoning_content: 'Calling the fixture.' })
    stream += chunk({ tool_calls: [{ index: 0, id: 'call_fixture_1', type: 'function', function: { name: 'FixtureEcho', arguments: mode === 'malformed' ? '{broken' : '{"text":' } }] })
    if (mode === 'tools') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] })
    stream += chunk({}, 'tool_calls')
  } else {
    if (mode !== 'misplaced' && body.reasoning_effort !== 'none') stream += chunk({ reasoning_content: 'Reasoning in the delta.' })
    stream += chunk({ content: 'FIREWORKS-FIXTURE-SETTLED' })
    if (mode !== 'truncated') stream += chunk({}, 'stop')
  }
  if (mode !== 'truncated') stream += chunk({}, null, { usage: { prompt_tokens: 32, completion_tokens: 103, total_tokens: 135, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 9 } } }) + 'data: [DONE]\n\n'
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', ...rates } })
} })
process.env.MERCURY_FIREWORKS_API_BASE = `http://127.0.0.1:${server.port}/inference/v1`
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  const { classifyModelRoute } = await import('../../src/services/providers/routeLaw.ts')
  check('Fireworks qualified ids are declared before any inference request', classifyModelRoute('fireworks/gpt-oss-120b').route === 'fireworks')
  const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
  const { refreshFireworksCatalogue, __resetFireworksCatalogueForTest, fireworksCatalogueRows, fireworksCatalogueSourceWords } = await import(new URL('../../src/services/providers/fireworks/fireworksCatalogue.ts', import.meta.url).href)
  const { buildFireworksExtras, fireworksCallModel } = await import(new URL('../../src/services/providers/fireworks/fireworksCallModel.ts', import.meta.url).href)
  const { storeFireworksApiKeyLogin } = await import(new URL('../../src/services/providers/fireworks/fireworksLogin.ts', import.meta.url).href)
  const { usageForProvider } = await import('../../src/services/providers/providerUsage.ts')
  const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
  const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
  const { keyLaneListState, keyLanePins } = await import('../../src/utils/model/modelOptions.ts')
  const { readStoredFireworksApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { liveModelsReference, knownModelsReference } = await import('../../src/services/resources/adapters/models.ts')
  const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
  function params(model = 'fireworks/gpt-oss-120b', effortValue = 'max', thinking = true, messages: Message[] = [createUserMessage({ content: 'hello fixture' })]): CompatCallModelParams {
    return { messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: thinking ? { type: 'enabled', budgetTokens: 4096 } : { type: 'disabled' }, signal: new AbortController().signal,
      options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue } as never }
  }
  async function run(p = params(), direct = false): Promise<AssistantMessage[]> {
    const settled: AssistantMessage[] = []
    for await (const event of (direct ? fireworksCallModel(p) : routedCallModel(p as never))) if (event.type === 'assistant') settled.push(event as AssistantMessage)
    return settled
  }
  const textOf = (rows: AssistantMessage[]): string => rows.flatMap(row => row.message.content).map(block => block.type === 'text' ? block.text : '').join('')
  const thinkingOf = (rows: AssistantMessage[]): string => rows.flatMap(row => row.message.content).map(block => block.type === 'thinking' ? block.thinking : '').join('')
  const words = (rows: AssistantMessage[]): string => rows.filter(row => row.isApiErrorMessage).map(row => JSON.stringify(row.message.content)).join(' ')
  check('a bare GPT OSS id keeps OpenAI ownership and a bare vendor slug is not Fireworks', classifyModelRoute('gpt-oss-120b').route === 'openai' && classifyModelRoute('qwen/qwen3.8-27b').kind === 'unrecognised')
  check('a key is configured, not yet a proven turn', resolvePrimaryAgentBackend('fireworks/gpt-oss-120b')?.readiness().state === 'configured')
  const first = await run()
  const body = captures[0]!.body
  check('the account list is read once and the bearer and wire id belong to Fireworks', listReads === 1 && captures[0]?.bearer && body.model === 'accounts/fireworks/models/gpt-oss-120b')
  check('Fireworks sends tools, streaming usage, high OSS effort and session affinity with no nested reasoning', body.tools[0].function.name === 'FixtureEcho' && body.tool_choice === 'auto' && body.stream_options.include_usage && body.stream && body.reasoning_effort === 'high' && Boolean(captures[0]?.affinity) && !('reasoning' in body) && !('thinking' in body))
  check('text, reasoning and disjoint usage settle from the final stream', textOf(first) === 'FIREWORKS-FIXTURE-SETTLED' && thinkingOf(first) === 'Reasoning in the delta.' && first.at(-1)?.message.usage.input_tokens === 28 && first.at(-1)?.message.usage.cache_read_input_tokens === 4 && first.at(-1)?.message.usage.output_tokens === 103)
  check('readiness advances only after settlement', resolvePrimaryAgentBackend('fireworks/gpt-oss-120b')?.readiness().state === 'ready')
  await run(params('fireworks/qwen3p8-max'))
  check('Qwen max stays max on the top-level effort dial', captures.at(-1)?.body.reasoning_effort === 'max')
  await run(params('fireworks/kimi-k3'))
  check('shorthand names normalize to full model resources', captures.at(-1)?.body.model === 'accounts/fireworks/models/kimi-k3')
  await run(params('fireworks/kimi-fast-latest'))
  check('the Fire Pass shorthand normalizes to its router resource', captures.at(-1)?.body.model === 'accounts/fireworks/routers/kimi-fast-latest')
  const overridden = params(); overridden.options.maxOutputTokensOverride = 128; await run(overridden)
  check('an explicit output ceiling uses max_tokens only', captures.at(-1)?.body.max_tokens === 128 && !('max_completion_tokens' in captures.at(-1)!.body))
  const meter = usageForProvider('fireworks')
  check('the meter keeps the three vendor TPM limits distinct and never invents remaining credit', meter.credits?.state === 'unreported' && meter.figures?.map(row => row.value).join(',') === '10000,5000,2000')
  mode = 'tools'; const tools = await run()
  check('fragmented tool JSON produces one validated call with the vendor id', tools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use').length === 1)
  mode = 'text'; await run(params(undefined, 'high', true, [...tools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_fixture_1', content: 'hello' }] })]))
  const history = captures.at(-1)!.body.messages
  check('the session-affinity header stays byte-identical across tool rounds', captures.at(-1)!.affinity === captures[0]!.affinity)
  check('tool/result identity survives replay and Fireworks receives interleaved reasoning_content', history.some((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'call_fixture_1') && history.some((row: any) => row.role === 'tool' && row.tool_call_id === 'call_fixture_1') && history.some((row: any) => row.reasoning_content === 'Calling the fixture.'))
  check('the picker filters image rows and qualifies every text row', fireworksCatalogueRows().rows.length === 5 && keyLanePins('fireworks').every(pin => pin.id.startsWith('fireworks/')))
  check('Agent exact dispatch keeps the qualified model', (await resolveEngineDispatch('fireworks/gpt-oss-120b'))?.model === 'fireworks/accounts/fireworks/models/gpt-oss-120b')
  check('the Agent family selector resolves to a qualified row without declaring a bare Fireworks model id', classifyModelRoute('fireworks').kind === 'unrecognised' && (await resolveEngineDispatch('fireworks'))?.model === 'fireworks/accounts/fireworks/models/kimi-k3')
  check('the live resource and 14 known pins carry Fireworks models (docs.fireworks.ai/serverless/pricing, read 2026-10-25)', (await liveModelsReference({ engineModel: 'fireworks/gpt-oss-120b' })).providers.find(row => row.provider === 'fireworks')?.models.length === 5 && (await knownModelsReference()).providers.find(row => row.provider === 'fireworks')?.models.length === 14 && (await knownModelsReference()).providers.find(row => row.provider === 'fireworks')?.familyWord === 'fireworks')
  const firepassLogin = await storeFireworksApiKeyLogin('fpk_proof_firepass_fixture_not_a_real_key')
  check('a Fire Pass fpk_ key stores on the same login road', firepassLogin.ok && firepassLogin.stored && readStoredFireworksApiKey() === 'fpk_proof_firepass_fixture_not_a_real_key')
  const login = await storeFireworksApiKeyLogin('proof-key-fireworks-login-fixture-not-a-real-key')
  check('the accepted key is stored with the environment-precedence receipt', login.ok && login.stored && readStoredFireworksApiKey() === 'proof-key-fireworks-login-fixture-not-a-real-key' && login.receipt.includes('FIREWORKS_API_KEY is set and wins'))
  console.log('\nrefusals')
  for (const [testMode, typed, needle] of [['auth', 'authentication_failed', '/logins fireworks'], ['billing', 'billing_error', 'payment_required'], ['rate', 'rate_limit', 'asks for a 1h wait']]) {
    mode = testMode!; const before = captures.length; const rows = await run()
    check(`${testMode} stays on Fireworks, refuses once and names the remedy or wait`, captures.length === before + 1 && rows.some(row => row.error === typed) && words(rows).includes(needle!))
    console.log(words(rows))
    if (testMode === 'billing') check('the billing observation belongs to Fireworks alone', laneBillingState('fireworks').state === 'credit-exhausted' && laneBillingState('mistral').state === 'clear')
  }
  mode = 'busy'; const beforeRetry = captures.length; await run()
  check('an overload retries Fireworks and a served turn clears the refusal', captures.length === beforeRetry + 2 && laneBillingState('fireworks').state === 'clear')
  mode = 'text'; await run(params(undefined, 'minimal'))
  check('unsupported minimal maps to the lowest served OSS rung, not a 400', captures.at(-1)?.body.reasoning_effort === 'low')
  await run(params('fireworks/kimi-k3', 'minimal'))
  check('minimal on a thinking-capable gateway row selects low, not none', captures.at(-1)?.body.reasoning_effort === 'low')
  await run(params(undefined, 'max', false))
  check('OSS thinking off uses low rather than the unsupported none word', captures.at(-1)?.body.reasoning_effort === 'low')
  await run(params('fireworks/qwen3p8-max', 'max', false))
  check('Qwen thinking off sends its documented none word', captures.at(-1)?.body.reasoning_effort === 'none')
  mode = 'misplaced'; const misplaced = await run()
  check('a reasoning field on the choice rather than its delta is ignored', thinkingOf(misplaced) === '' && textOf(misplaced) === 'FIREWORKS-FIXTURE-SETTLED')
  mode = 'malformed'
  check('malformed tool arguments keep their call identity and receive an error result without execution', await assertRefusedCallResult(await run(), { id: 'call_fixture_1', name: 'FixtureEcho', raw: '{broken' }))
  mode = 'truncated'; check('missing terminal data remains a visible fault beside partial text', (await run()).some(row => row.isApiErrorMessage))
  mode = 'text'; const beforeAbsent = captures.length
  for (const id of ['fireworks/missing-fixture', 'fireworks/flux-fixture', 'fireworks/', 'fireworks/fireworks/foo', 'accounts/fireworks/models/gpt-oss-120b', 'gpt-oss-120b']) {
    const refused = await run(params(id), true)
    check(`unserved or unqualified id refuses before inference: ${id}`, captures.length === beforeAbsent && refused.some(row => row.error === 'invalid_request'))
    console.log(words(refused))
  }
  listStatus = 401
  const refusedLogin = await storeFireworksApiKeyLogin('proof-key-fireworks-refused-fixture-not-a-real-key')
  check('a refused login never overwrites the stored key', !refusedLogin.stored && refusedLogin.receipt.includes('HTTP 401') && readStoredFireworksApiKey() === 'proof-key-fireworks-login-fixture-not-a-real-key')
  listStatus = 200; modelList = []; await refreshFireworksCatalogue({ force: true })
  const emptyBefore = captures.length
  const { fireworksDisplayPin, FIREWORKS_OBSERVED_AT } = await import('../../src/services/providers/fireworks/fireworksPins.ts')
  check('an empty live list falls to the 14 dated pins (docs.fireworks.ai pricing, read 2026-10-25) labelled as pins with each row\'s own date, admits a pinned id under the note, and refuses an unpinned id', fireworksCatalogueRows().source.kind === 'pins' && fireworksCatalogueRows().rows.length === 14 && fireworksCatalogueRows().rows.every((row: any) => !row.listedLive && row.observedAt === (fireworksDisplayPin(row.id)?.observedAt ?? FIREWORKS_OBSERVED_AT)) && keyLaneListState('fireworks').kind === 'pin' && (fireworksCatalogueSourceWords() ?? '').includes('pinned list — ') && !(await run()).some(row => row.isApiErrorMessage) && captures.length === emptyBefore + 1 && (await run(params('fireworks/missing-fixture'))).some(row => row.isApiErrorMessage) && captures.length === emptyBefore + 1)
  const beforeUnreachable = captures.length
  modelList = fixtures; __resetFireworksCatalogueForTest(); const base = process.env.MERCURY_FIREWORKS_API_BASE
  process.env.MERCURY_FIREWORKS_API_BASE = 'http://127.0.0.1:1/inference/v1'
  await refreshFireworksCatalogue({ force: true })
  check('unreachable catalogue falls back to dated, explicitly labelled pins', fireworksCatalogueRows().source.kind === 'pins' && keyLaneListState('fireworks').kind === 'pin' && fireworksCatalogueRows().rows.every((row: any) => !row.listedLive && row.observedAt === (fireworksDisplayPin(row.id)?.observedAt ?? FIREWORKS_OBSERVED_AT)) && fireworksCatalogueSourceWords().includes('pinned list'))
  process.env.MERCURY_FIREWORKS_API_BASE = base
  const controller = new AbortController(); controller.abort()
  check('pre-aborted calls perform no inference', (await run({ ...params(), signal: controller.signal })).length === 0 && captures.length === beforeUnreachable)
  check('unknown rows get no invented reasoning field or output ceiling', JSON.stringify(buildFireworksExtras({ wireModel: 'fixture-new-chat', effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: undefined })) === '{"stream_options":{"include_usage":true}}')
  const { proveExistingCompatKnobs } = await import('../providers/lib/fast-infer-control.ts')
  await proveExistingCompatKnobs()
  console.log(`FIREWORKS WIRE GREEN (${count} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
