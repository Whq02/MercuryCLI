import '../lib/hermetic.ts'
import { assertRefusedCallResult } from '../providers/lib/refused-call-result.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import fixture from '../providers/fixtures/melious-documented-2026-10-24.json'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'ANTHROPIC_BASE_URL']) delete process.env[name]
process.env.MELIOUS_API_KEY = 'proof-key-melious-wire-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BUSY_RETRY_SCALE = '0.001'
let mode = 'text'
let listReads = 0
const requests: Array<Record<string, any>> = []
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const chunk = (delta: unknown, finish: string | null = null) => sse({ id: 'chatcmpl-...', object: 'chat.completion.chunk', created: 1699999999, model: 'glm-5.3', choices: [{ index: 0, delta, finish_reason: finish }] })
const errorBody = (type: string, code: string) => ({ error: { message: code, type, param: null, code } })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url)
  assert.equal(req.headers.get('authorization'), `Bearer ${process.env.MELIOUS_API_KEY}`)
  if (url.pathname === '/v1/models') {
    listReads++
    assert.equal(url.search, '?include_meta=true')
    return Response.json(fixture.models)
  }
  assert.equal(url.pathname, '/v1/chat/completions')
  assert.equal(req.method, 'POST')
  const body = await req.json() as Record<string, any>
  requests.push(body)
  const fail = (status: number, type: string, code: string, headers = {}) => Response.json(errorBody(type, code), { status, headers })
  if (mode === 'auth') return fail(401, 'authentication_error', 'invalid_api_key')
  if (mode === 'scope') return fail(403, 'authentication_error', 'auth_insufficient_scope')
  if (mode === 'billing') return fail(429, 'billing_error', 'billing_insufficient_balance')
  if (mode === 'billing-new-code') return fail(429, 'billing_error', 'future_balance_code')
  if (mode === 'hold') { mode = 'text'; return fail(429, 'billing_error', 'billing_hold_creation_failed') }
  if (mode === 'rate') { mode = 'text'; return Response.json(fixture.throttle, { status: 429, headers: { 'retry-after': '0', ...fixture.rateHeaders } }) }
  if (mode === 'busy') { mode = 'text'; return fail(503, 'server_error', 'provider_error', { 'retry-after': '0' }) }
  if (mode === 'stream-billing') return new Response(sse(errorBody('billing_error', 'insufficient_quota')) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  if (mode === 'stream-busy') { mode = 'text'; return new Response(sse(errorBody('server_error', 'provider_error')) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) }
  let stream = ''
  if (['tools', 'malformed', 'tool-cut'].includes(mode)) {
    stream += chunk({ reasoning_content: 'Calling the weather function.' })
    stream += chunk({ tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: mode === 'malformed' ? '{bad' : '{"city":' } }] })
    if (mode !== 'malformed') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"Hamburg"}' } }] })
    stream += chunk({}, 'tool_calls')
  } else if (mode === 'done-only') {
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } else {
    if (body.reasoning_effort !== 'none') stream += chunk({ reasoning_content: 'Reasoning from Melious.' })
    stream += chunk({ content: 'MELIOUS-FIXTURE-SETTLED' })
    if (mode === 'wait') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(stream)) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (mode === 'partial-error') stream += sse(errorBody('server_error', 'provider_error'))
    else if (mode !== 'truncated') stream += chunk({}, mode === 'blocked' ? 'blocked' : 'stop')
  }
  const usage = { ...fixture.usageChunk, usage: { ...fixture.usageChunk.usage, cached_tokens: 4, reasoning_tokens: 2, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } } }
  if (!['truncated', 'tool-cut', 'no-done', 'partial-error'].includes(mode)) stream += sse(usage)
  if (!['truncated', 'tool-cut', 'no-done'].includes(mode)) stream += 'data: [DONE]\n\n'
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', ...fixture.rateHeaders } })
} })
process.env.MERCURY_MELIOUS_API_BASE = `http://127.0.0.1:${server.port}/v1`
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { classifyModelRoute, canonicalWireModelId } = await import('../../src/services/providers/routeLaw.ts')
  const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
  const { buildMeliousExtras, streamMeliousChat } = await import('../../src/services/providers/melious/meliousCallModel.ts')
  const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
  const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
  const tool = { name: 'get_weather', description: async () => 'Current weather for a city', prompt: async () => 'Current weather for a city', inputSchema: z.object({ city: z.string() }), userFacingName: () => 'get_weather', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
  function params(model = 'melious/glm-5.3', messages: Message[] = [createUserMessage({ content: 'Weather in Hamburg?' })]): CompatCallModelParams {
    return { messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, signal: new AbortController().signal,
      options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'max' } as never }
  }
  async function run(p = params()): Promise<AssistantMessage[]> {
    const settled: AssistantMessage[] = []
    for await (const event of routedCallModel(p as never)) if (event.type === 'assistant') settled.push(event as AssistantMessage)
    return settled
  }
  const blocks = (rows: AssistantMessage[]) => rows.flatMap(row => row.message.content)
  const errors = (rows: AssistantMessage[]) => rows.filter(row => row.isApiErrorMessage)
  check('qualified models route to Melious without stealing native GLM ownership', classifyModelRoute('melious/glm-5.3:eco').route === 'melious' && classifyModelRoute('glm-5.3').route === 'zai')
  check('canonicalization strips only the carrier and context annotation', canonicalWireModelId('melious/glm-5.3:price[1m]').wireId === 'glm-5.3:price')
  check('key presence does not claim a completed turn', resolvePrimaryAgentBackend('melious/glm-5.3')?.readiness().state === 'configured')
  const first = await run()
  check('dispatch reads the keyed metadata catalogue then the chat endpoint', listReads === 1 && requests[0]?.model === 'glm-5.3')
  check('streaming usage and max effort reach the wire unchanged', requests[0]?.stream === true && requests[0]?.stream_options.include_usage === true && requests[0]?.reasoning_effort === 'max')
  check('no invented output cap or foreign reasoning dialect is sent', !('max_tokens' in requests[0]!) && !('max_completion_tokens' in requests[0]!) && !('thinking' in requests[0]!))
  check('the full tool schema uses function tools and auto choice', requests[0]?.tools[0]?.function.name === 'get_weather' && requests[0]?.tools[0]?.function.parameters.required.includes('city') && requests[0]?.tool_choice === 'auto')
  check('reasoning and text both settle', blocks(first).some(block => block.type === 'thinking' && block.thinking.includes('Reasoning from Melious.')) && blocks(first).some(block => block.type === 'text' && block.text === 'MELIOUS-FIXTURE-SETTLED') && errors(first).length === 0)
  check('cached tokens are counted once and reasoning remains an output subset', first.at(-1)?.message.usage.input_tokens === 8 && first.at(-1)?.message.usage.cache_read_input_tokens === 4 && first.at(-1)?.message.usage.output_tokens === 7 && first.at(-1)?.message.usage.output_tokens_details?.thinking_tokens === 2)
  check('a completed turn earns readiness', resolvePrimaryAgentBackend('melious/glm-5.3')?.readiness().state === 'ready')
  for (const flavor of ['speed', 'price', 'eco']) {
    await run(params(`melious/glm-5.3:${flavor}`))
    check(`${flavor} remains a routing suffix on the wire`, requests.at(-1)?.model === `glm-5.3:${flavor}` && requests.at(-1)?.reasoning_effort === 'max')
  }
  const engine = await resolveEngineDispatch('melious/glm-5.3:eco')
  check('crewmate exact-id dispatch keeps the Melious provider', engine.backend === 'melious' && engine.model === 'melious/glm-5.3:eco')
  check('an explicit output request and thinking-off setting keep their wire spelling', JSON.stringify(buildMeliousExtras({ wireModel: 'glm-5.3', effortValue: 'max', thinkingEnabled: false, maxOutputTokensOverride: 32768 })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"none","max_tokens":32768}')
  const isolatedRequest = { url: process.env.MERCURY_MELIOUS_API_BASE + '/chat/completions', request: { model: 'glm-5.3', messages: [] } }
  const costEvents = []
  for await (const event of streamMeliousChat({ ...isolatedRequest, fetchImpl: (async () => new Response(chunk({}, 'stop') + sse({ ...fixture.usageChunk, usage: { ...fixture.usageChunk.usage, cost: 99 } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch })) costEvents.push(event)
  check('an undocumented upstream cost cannot become a Melious USD charge', costEvents.some(event => event.type === 'usage' && event.usage.statedCostUSD === undefined))
  const billingEvents = []
  for await (const event of streamMeliousChat({ ...isolatedRequest, fetchImpl: (async () => Response.json(errorBody('billing_error', 'insufficient_quota'), { status: 429 })) as typeof fetch })) billingEvents.push(event)
  check('billing classification preserves the real HTTP status and provider code', billingEvents.some(event => event.type === 'stream-fault' && event.fault.status === 429 && event.fault.code === 'api-insufficient_quota' && event.fault.classification === 'billing_error'))
  mode = 'tools'
  const tools = await run()
  const call = blocks(tools).find(block => block.type === 'tool_use')
  check('fragmented JSON makes exactly one correlated tool call', blocks(tools).filter(block => block.type === 'tool_use').length === 1 && call?.type === 'tool_use' && call.id === 'call_abc' && (call.input as any).city === 'Hamburg')
  mode = 'text'
  await run(params('melious/glm-5.3', [createUserMessage({ content: 'Weather in Hamburg?' }), ...tools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: '{"temperature":22}' }] })]))
  const replay = requests.at(-1)!.messages
  const assistant = replay.findIndex((row: any) => row.role === 'assistant' && row.tool_calls?.length)
  check('tool replay retains identity order and result content', assistant >= 0 && replay[assistant].tool_calls[0].id === 'call_abc' && replay[assistant + 1].role === 'tool' && replay[assistant + 1].tool_call_id === 'call_abc' && replay[assistant + 1].content === '{"temperature":22}')
  check('undocumented reasoning replay is not invented', replay.every((row: any) => !('reasoning_content' in row)))
  mode = 'malformed'
  check('malformed tool arguments keep their call identity and receive an error result without execution', await assertRefusedCallResult(await run(), { id: 'call_abc', name: 'get_weather', raw: '{bad' }))
  for (const fault of ['truncated', 'no-done', 'done-only', 'tool-cut', 'partial-error', 'blocked']) {
    mode = fault
    const before = requests.length
    const reply = await run()
    check(`${fault} reports a fault without executing a failed tool or retrying partial output`, errors(reply).length > 0 && !blocks(reply).some(block => block.type === 'tool_use') && requests.length === before + 1)
  }
  for (const refusal of ['auth', 'scope', 'billing', 'billing-new-code', 'stream-billing']) {
    mode = refusal
    const before = requests.length
    const reply = await run()
    check(`${refusal} remains a refusal, not a retry loop`, errors(reply).length > 0 && requests.length === before + 1)
    if (refusal.includes('billing')) check(`${refusal} is typed as billing rather than a throttle`, errors(reply).at(-1)?.error === 'billing_error')
  }
  check('billing refusal is observed for the right provider', laneBillingState('melious').state === 'credit-exhausted')
  mode = 'text'
  check('a fresh request after billing refusal still reaches the provider', errors(await run()).length === 0 && laneBillingState('melious').state === 'clear')
  for (const retry of ['rate', 'busy', 'hold', 'stream-busy']) {
    mode = retry
    const before = requests.length
    check(`${retry} retries before output and settles the successful response`, errors(await run()).length === 0 && requests.length === before + 2 && requests.at(-1)?.reasoning_effort === 'max')
  }
  mode = 'text'
  const absent = requests.length
  const abort = new AbortController(); abort.abort()
  check('pre-cancelled dispatch performs no request', (await run({ ...params(), signal: abort.signal })).length === 0 && requests.length === absent)
  mode = 'wait'
  const mid = new AbortController()
  const midRows: AssistantMessage[] = []
  for await (const event of routedCallModel({ ...params(), signal: mid.signal } as never)) {
    if (event.type === 'stream_event' && event.event.type === 'content_block_delta') mid.abort()
    if (event.type === 'assistant') midRows.push(event as AssistantMessage)
  }
  check('in-flight cancellation returns without an API error', mid.signal.aborted && errors(midRows).length === 0)
  console.log(`MELIOUS WIRE GREEN (${count} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
