import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import fixture from './fixtures/orcarouter-documented.json'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'ANTHROPIC_BASE_URL']) delete process.env[key]
process.env.ORCAROUTER_API_KEY = 'proof-key-orcarouter-fixture-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BUSY_RETRY_SCALE = '0.01'
let mode = 'text'
let listStatus = 200
let list: unknown[] = fixture.catalogue.data
let billingUnlimited = false
let listReads = 0
const captures: Array<{ body: Record<string, any>; bearer: boolean; cost: string | null }> = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url)
  if (url.pathname === '/v1/models') {
    listReads++
    assert.equal(url.searchParams.get('capability'), 'chat')
    return Response.json(listStatus === 200 ? { object: 'list', data: list } : { error: { message: 'invalid api key', type: 'orcarouter_api_error' } }, { status: listStatus })
  }
  if (url.pathname === '/v1/dashboard/billing/usage') return Response.json(fixture.billingUsage)
  if (url.pathname === '/v1/dashboard/billing/subscription') return Response.json(billingUnlimited ? { hard_limit_usd: 100000000, access_until: 0 } : fixture.billingSubscription)
  assert.equal(url.pathname, '/v1/chat/completions')
  const body = await req.json() as Record<string, any>
  captures.push({ body, bearer: req.headers.get('authorization') === `Bearer ${process.env.ORCAROUTER_API_KEY}`, cost: req.headers.get('x-orcarouter-include-cost') })
  const fail = (status: number, code: string, message: string, headers = {}) => Response.json({ error: { message, type: 'orcarouter_api_error', code } }, { status, headers })
  if (mode === 'auth') return fail(401, 'invalid_api_key', 'invalid api key')
  if (mode === 'billing') return fail(402, 'insufficient_user_quota', 'workspace out of credits')
  if (mode === 'budget') return fail(403, 'budget_exceeded', 'monthly budget reached for this member')
  if (mode === 'key-quota') return fail(403, 'pre_consume_token_quota_failed', 'token quota is not enough')
  if (mode === 'cycle') return fail(403, 'access_denied', 'token cycle spend limit reached, resets at 2026-11-01T00:00:00Z')
  if (mode === 'byok') return fail(503, 'byok:key_unavailable', 'the workspace provider key is unavailable')
  if (mode === 'rate') return new Response(null, { status: 429, headers: { 'retry-after': '3600' } })
  if (mode === 'busy') { mode = 'text'; return fail(503, 'server_error', 'temporarily unavailable') }
  const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  let stream = chunk({ role: 'assistant', content: '' })
  if (mode === 'tools' || mode === 'malformed') {
    stream += chunk({ reasoning_content: 'Calling the fixture.' })
    stream += chunk({ tool_calls: [{ index: 0, id: 'call_fixture_1', type: 'function', function: { name: 'FixtureEcho', arguments: mode === 'malformed' ? '{broken' : '{"text":' } }] })
    if (mode === 'tools') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] })
    stream += chunk({}, 'tool_calls')
  } else {
    stream += chunk({ reasoning_content: 'Reasoning in the delta.' })
    stream += chunk({ content: 'ORCAROUTER-FIXTURE-SETTLED' })
    if (mode === 'inband') stream += `data: ${JSON.stringify({ error: { message: 'fixture upstream failed', type: 'upstream_error', code: '' } })}\n\n`
    else if (mode !== 'truncated') stream += chunk({}, 'stop')
  }
  if (mode !== 'truncated') stream += `data: ${JSON.stringify({ choices: [], usage: { ...fixture.usage, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 9 } } })}\n\ndata: [DONE]\n\n`
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-orca-resolved-model': 'openai/gpt-4o-mini', 'x-orca-request-id': 'fixture-request' } })
} })
process.env.MERCURY_ORCAROUTER_API_BASE = `http://127.0.0.1:${server.port}/v1`
let checks = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); checks++; console.log(`[PASS] ${name}`) }
try {
  const { classifyModelRoute, canonicalWireModelId } = await import('../../src/services/providers/routeLaw.ts')
  check('OrcaRouter has its own route', classifyModelRoute('orcarouter/openai/gpt-4o-mini').route === 'orcarouter')
  check('native prefixes cannot steal a qualified route', classifyModelRoute('orcarouter/anthropic/claude-sonnet-4.6').route === 'orcarouter' && classifyModelRoute('gpt-4o-mini').route === 'openai')
  check('the carrier strips once, including its own named-router slug', canonicalWireModelId('orcarouter/orcarouter/auto').wireId === 'orcarouter/auto' && canonicalWireModelId('orcarouter/gpt-4o-mini').wireId === 'gpt-4o-mini')
  check('annotations detach and suffixes remain', canonicalWireModelId('orcarouter/anthropic/claude-sonnet-4.6-max[1m]').wireId === 'anthropic/claude-sonnet-4.6-max')
  check('empty and doubly-composed vendor slugs refuse', !canonicalWireModelId('orcarouter/').ok && !canonicalWireModelId('orcarouter/orcarouter/openai/gpt-4o-mini').ok)
  const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
  const catalogue = await import('../../src/services/providers/orcarouter/orcarouterCatalogue.ts')
  const { getModelOptions, keyLaneListState } = await import('../../src/utils/model/modelOptions.ts')
  const { getContextWindowForModel, getModelMaxOutputTokens, modelReceivesImageBlocks } = await import('../../src/utils/model/capabilities.ts')
  const { resolveModelPricing } = await import('../../src/utils/modelCost.ts')
  const { usageForProvider, refreshProviderUsage } = await import('../../src/services/providers/providerUsage.ts')
  const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
  const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
  const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
  function params(model = 'orcarouter/orcarouter/auto', effortValue = 'max', messages: Message[] = [createUserMessage({ content: 'hello fixture' })]): CompatCallModelParams {
    return { messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, signal: new AbortController().signal,
      options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue } as never }
  }
  async function run(p = params()): Promise<AssistantMessage[]> {
    const settled: AssistantMessage[] = []
    for await (const event of routedCallModel(p as never)) if (event.type === 'assistant') settled.push(event as AssistantMessage)
    return settled
  }
  const textOf = (rows: AssistantMessage[]) => rows.flatMap(row => row.message.content).map(block => block.type === 'text' ? block.text : '').join('')
  check('a credential alone is not a served turn', resolvePrimaryAgentBackend('orcarouter/orcarouter/auto')?.readiness().state === 'configured')
  await catalogue.refreshOrcarouterCatalogue({ force: true })
  check('the keyed live catalogue lists three models', listReads === 1 && catalogue.orcarouterCatalogueRows().rows.length === 3)
  check('the picker preserves provider-qualified identities without status prose', getModelOptions().filter(row => row.value.startsWith('orcarouter/')).every(row => row.description === '') && keyLaneListState('orcarouter').kind === 'live')
  check('live context, output ceiling and image modalities reach capabilities', getContextWindowForModel('orcarouter/anthropic/claude-sonnet-4.6') === 200000 && getModelMaxOutputTokens('orcarouter/anthropic/claude-sonnet-4.6').upperLimit === 64000 && modelReceivesImageBlocks('orcarouter/anthropic/claude-sonnet-4.6'))
  const pricing = resolveModelPricing('orcarouter/openai/gpt-4o-mini')
  check('per-token catalogue prices stay on the OrcaRouter lane', pricing.basis === 'recorded' && Math.abs(pricing.costs.inputTokens - 0.15) < 1e-10 && pricing.costs.outputTokens === 0.6)
  check('missing prices never borrow an upstream tier', resolveModelPricing('orcarouter/anthropic/claude-sonnet-4.6').basis === 'unpriced')
  const first = await run()
  const request = captures.at(-1)!
  check('shared transport sends bearer auth, the native slug and cost opt-in', request.bearer && request.body.model === 'orcarouter/auto' && request.cost === 'true')
  check('the full function tool shape, usage stream and max effort reach the wire', request.body.tools[0].function.name === 'FixtureEcho' && request.body.tool_choice === 'auto' && request.body.stream_options.include_usage && request.body.stream && request.body.reasoning_effort === 'max')
  check('session affinity has a stable opaque cache key', typeof request.body.prompt_cache_key === 'string' && request.body.prompt_cache_key.length > 0)
  check('text, reasoning and disjoint cached usage settle', textOf(first) === 'ORCAROUTER-FIXTURE-SETTLED' && first.some(row => row.message.content.some(block => block.type === 'thinking')) && first.at(-1)?.message.usage.input_tokens === 1000 && first.at(-1)?.message.usage.cache_read_input_tokens === 100 && first.at(-1)?.message.usage.output_tokens === 420)
  check('inline USD overrides catalogue estimates at settlement', Math.abs(usageForProvider('orcarouter').spend.costUSD - fixture.usage.cost_usd) < 1e-10)
  check('readiness advances after a served turn', resolvePrimaryAgentBackend('orcarouter/orcarouter/auto')?.readiness().state === 'ready')
  await run(params('orcarouter/anthropic/claude-sonnet-4.6'))
  check('the listed output ceiling is sent in full', captures.at(-1)?.body.max_completion_tokens === 64000)
  await run(params(undefined, 'xhigh'))
  check('explicit xhigh effort is not lowered to high', captures.at(-1)?.body.reasoning_effort === 'xhigh')
  mode = 'tools'; const tools = await run()
  check('fragmented arguments become one executable tool call', tools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use').length === 1)
  mode = 'text'; await run(params(undefined, 'max', [...tools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_fixture_1', content: 'hello' }] })]))
  const history = captures.at(-1)!.body.messages
  check('tool/result identity and requested effort survive continuation', history.some((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'call_fixture_1') && history.some((row: any) => row.role === 'tool' && row.tool_call_id === 'call_fixture_1') && captures.at(-1)?.body.reasoning_effort === 'max')
  check('signed reasoning is not invented on the chat replay', history.every((row: any) => !('reasoning_content' in row)))
  check('Agent exact dispatch and family selection stay on OrcaRouter', (await resolveEngineDispatch('orcarouter/orcarouter/auto'))?.backend === 'orcarouter' && (await resolveEngineDispatch('orcarouter'))?.model.startsWith('orcarouter/'))
  await refreshProviderUsage('orcarouter', { force: true })
  check('billing cents and total-credit units yield remaining credit', usageForProvider('orcarouter').balance?.display === 'USD 7.25 remaining credit')
  billingUnlimited = true; await refreshProviderUsage('orcarouter', { force: true })
  check('an unlimited key is not a fabricated wallet', usageForProvider('orcarouter').balance === undefined && usageForProvider('orcarouter').credits?.state === 'unreported')
  const { readSignInRefusal } = await import('../../src/utils/accounts/signInRefusal.ts')
  for (const testMode of ['budget', 'key-quota', 'cycle', 'byok']) {
    mode = testMode; const before = captures.length; const result = await run()
    check(`${testMode} is terminal policy, not an expired credential`, captures.length === before + 1 && result.some(row => row.error === 'invalid_request') && readSignInRefusal('orcarouter') === undefined)
  }
  for (const [testMode, error] of [['auth', 'authentication_failed'], ['billing', 'billing_error'], ['rate', 'rate_limit']]) {
    mode = testMode!; const before = captures.length; const result = await run()
    check(`${testMode} refuses once on its own provider`, captures.length === before + 1 && result.some(row => row.error === error))
  }
  check('billing refusal is recorded for OrcaRouter only', laneBillingState('orcarouter').state === 'credit-exhausted' && laneBillingState('groq').state === 'clear')
  mode = 'busy'; const beforeRetry = captures.length; await run()
  check('retry reaches the same provider and clears the old refusal on success', captures.length === beforeRetry + 2 && laneBillingState('orcarouter').state === 'clear')
  mode = 'malformed'; check('malformed tools are never executable', !(await run()).some(row => row.message.content.some(block => block.type === 'tool_use')))
  mode = 'truncated'; check('a missing terminal leaves partial text and an error', (await run()).some(row => row.isApiErrorMessage))
  mode = 'inband'; check('HTTP 200 with an in-band error is not success', (await run()).some(row => row.isApiErrorMessage))
  const cancelled = new AbortController(); cancelled.abort(); const beforeCancel = captures.length
  check('cancellation never sends another request', (await run({ ...params(), signal: cancelled.signal })).length === 0 && captures.length === beforeCancel)
  listStatus = 503; list = []; process.env.ORCAROUTER_API_KEY = 'proof-key-orcarouter-second-fixture-not-a-real-key'
  await catalogue.refreshOrcarouterCatalogue({ force: true })
  check('an unread account can use the dated ID-only fallback list', catalogue.orcarouterCatalogueRows().source.kind === 'pins' && catalogue.orcarouterCatalogueRows().rows.length === 4)
  check('a new credential cannot inherit prices or balance', resolveModelPricing('orcarouter/openai/gpt-4o-mini').basis === 'unpriced' && usageForProvider('orcarouter').balance === undefined)
  listStatus = 200; await catalogue.refreshOrcarouterCatalogue({ force: true })
  check('a successful empty list stays empty', catalogue.orcarouterCatalogueRows().source.kind === 'live' && catalogue.orcarouterCatalogueRows().rows.length === 0)
  console.log(`ORCAROUTER WIRE GREEN (${checks} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
