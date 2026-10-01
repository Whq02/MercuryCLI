#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.XAI_API_KEY = 'xai-fixture-wire-not-a-real-key'
let mode: 'text' | 'tools' | 'malformed' | 'auth' | 'billing' | 'busy' = 'text'
let modelList: unknown[] = [{ id: 'grok-4.7', created: 2 }, { id: 'grok-4.3', created: 1 }]
const captures: Array<{ path: string; body: Record<string, any>; bearer: boolean; headers: Record<string, string> }> = []
let listReads = 0
const listPaths: Array<{ path: string; bearer: string | null }> = []
let holdList: Promise<void> | undefined
let listEntered: (() => void) | undefined
const sse = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (path === '/v1/models' || path === '/proxy/v1/models') { listReads++; listPaths.push({ path, bearer: req.headers.get('authorization') }); listEntered?.(); await holdList; return Response.json({ data: modelList }) }
  assert.notEqual(path, '/v1/responses', 'a Grok subscription never posts Responses on the API-key base')
  if (path === '/proxy/v1/responses') {
    const body = await req.json() as Record<string, any>
    captures.push({ path, body, bearer: req.headers.get('authorization') === 'Bearer fixture-subscription-access', headers: Object.fromEntries(req.headers.entries()) })
    assert.ok(!/opencode|openclaw|hermes/i.test(req.headers.get('user-agent') ?? ''))
    assert.equal(req.headers.get('X-XAI-Token-Auth'), 'xai-grok-cli')
    assert.equal(req.headers.get('x-grok-model-override'), body.model)
    assert.ok(req.headers.get('x-grok-client-version'))
    const item = mode === 'tools'
      ? { type: 'function_call', id: 'fc_sub', call_id: 'call_sub', name: 'FixtureEcho', arguments: '{"text":"subscription"}', status: 'completed' }
      : { type: 'message', id: 'msg_sub', role: 'assistant', content: [{ type: 'output_text', text: 'GROK-SUBSCRIPTION-SETTLED', annotations: [] }], status: 'completed' }
    const encrypted = { type: 'reasoning', id: 'rs_sub', encrypted_content: 'fixture-encrypted', summary: [] }
    const output = [encrypted, item]
    const stream = sse({ type: 'response.created', response: { id: 'resp_sub', model: body.model, status: 'in_progress' } })
      + sse({ type: 'response.output_item.done', output_index: 0, item: encrypted })
      + (mode === 'tools' ? '' : sse({ type: 'response.output_text.delta', item_id: 'msg_sub', output_index: 1, content_index: 0, delta: 'GROK-SUBSCRIPTION-SETTLED' }))
      + sse({ type: 'response.output_item.done', output_index: 1, item })
      + sse({ type: 'response.completed', response: { id: 'resp_sub', model: body.model, status: 'completed', output, usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } } })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }
  assert.equal(path, '/v1/chat/completions')
  assert.equal(req.method, 'POST')
  const raw = await req.text()
  assert.ok(!raw.includes(process.env.XAI_API_KEY!))
  const body = JSON.parse(raw)
  assert.equal(req.headers.has('X-XAI-Token-Auth'), false)
  captures.push({ path, body, bearer: req.headers.get('authorization') === `Bearer ${process.env.XAI_API_KEY}`, headers: Object.fromEntries(req.headers.entries()) })
  if (mode === 'auth' || mode === 'billing' || mode === 'busy') {
    const status = mode === 'auth' ? 401 : mode === 'billing' ? 402 : 503
    if (mode === 'busy') mode = 'text'
    return Response.json({ error: { message: status === 503 ? 'provider overloaded' : status === 402 ? 'insufficient credits' : 'invalid API key' } }, { status, headers: { 'x-should-retry': 'false' } })
  }
  const chunk = (delta: unknown, finish: string | null = null): string => sse({ id: 'xai-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
  let stream = chunk({ role: 'assistant', reasoning_content: 'fixture reasoning' })
  if (mode === 'tools' || mode === 'malformed') {
    stream += chunk({ tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'FixtureEcho', arguments: mode === 'malformed' ? '{broken' : '{"text":' } }] })
    if (mode === 'tools') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] })
    stream += chunk({}, 'tool_calls')
  } else stream += chunk({ content: 'GROK-FIXTURE-SETTLED' }) + chunk({}, 'stop')
  stream += sse({ choices: [], usage: { prompt_tokens: 32, completion_tokens: 9, total_tokens: 135, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 94 }, cost_in_usd_ticks: 37756000 } })
  return new Response(stream + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MERCURY_XAI_API_BASE = `http://127.0.0.1:${server.port}/v1`
process.env.MERCURY_XAI_GROK_PROXY_BASE = `http://127.0.0.1:${server.port}/proxy/v1`
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
const { refreshXaiCatalogue } = await import('../../src/services/providers/xai/xaiCatalogue.ts')
const { decodeCompatUsage } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { xaiLaneProfile } = await import('../../src/services/providers/xai/xaiCallModel.ts')
const { buildXaiExtras } = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
function params(model = 'grok', effortValue: string | undefined = 'max', thinking = true, messages: Message[] = [createUserMessage({ content: 'hello fixture' })]): CompatCallModelParams {
  return { messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: thinking ? { type: 'enabled', budgetTokens: 4096 } : { type: 'disabled' }, signal: new AbortController().signal,
    options: { model, querySource: 'repl_main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue, maxOutputTokensOverride: 512 } as never }
}
async function run(p = params()): Promise<AssistantMessage[]> {
  const settled: AssistantMessage[] = []
  for await (const event of routedCallModel(p as never)) if (event.type === 'assistant') settled.push(event as AssistantMessage)
  return settled
}
let checks = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); checks++; console.log(`[PASS] ${name}`) }
try {
  check('the primary backend is first-class xAI', resolvePrimaryAgentBackend('grok-4.7')?.id === 'xai-chat')
  check('the key alone is usable, not a fabricated usage allowance', resolveProviderUsability().xai.usable)
  const first = await run()
  const body = captures[0]!.body
  check('first alias dispatch reads the live list and sends its newest id', listReads === 1 && body.model === 'grok-4.7' && captures[0]?.bearer)
  check('native chat request carries nested function tools and streaming usage', body.stream === true && body.stream_options.include_usage === true && body.tools[0].type === 'function' && body.tools[0].function.name === 'FixtureEcho')
  check('the per-model effort clamps max to xhigh; no borrowed thinking object or Responses fields', body.reasoning_effort === 'xhigh' && !('thinking' in body) && !('input' in body) && !('reasoning' in body))
  check('explicit output override uses max_completion_tokens; unsupported penalty/stop parameters stay absent', body.max_completion_tokens === 512 && !('max_tokens' in body) && !('frequency_penalty' in body) && !('presence_penalty' in body) && !('stop' in body))
  check('text and reasoning settle through the shared stream', first.some(row => row.message.content.some(block => block.type === 'text' && block.text.includes('GROK-FIXTURE-SETTLED'))) && first.some(row => row.message.content.some(block => block.type === 'thinking')))
  const usage = first.at(-1)?.message.usage
  check('cached input and total-stated reasoning are accounted once', usage?.input_tokens === 28 && usage.cache_read_input_tokens === 4 && usage.output_tokens === 103)
  const decoded = decodeCompatUsage({ prompt_tokens: 32, completion_tokens: 9, total_tokens: 135, completion_tokens_details: { reasoning_tokens: 94 }, cost_in_usd_ticks: 37756000 })!
  check('xAI exact cost ticks decode without changing standard USD cost precedence', decoded.statedCostUSD === 0.0037756 && decodeCompatUsage({ prompt_tokens: 1, cost: 0.2, cost_in_usd_ticks: 1 })?.statedCostUSD === 0.2)
  check('a host already counting reasoning in completion is not double-counted', xaiLaneProfile.usageForSettlement!({ inputTokens: 32, outputTokens: 103, reasoningTokens: 94, totalTokens: 135 }).outputTokens === 103)
  await run(params('grok-4.7', 'max', false))
  check('thinking off takes the lowest served effort, never an unsupported none', captures.at(-1)?.body.reasoning_effort === 'low')
  await run(params('grok-4.3', 'max', false))
  check('a model documenting none can turn reasoning off', captures.at(-1)?.body.reasoning_effort === 'none')
  check('an unrecorded effort vocabulary sends no effort and no implicit output ceiling', JSON.stringify(buildXaiExtras({ wireModel: 'grok-fixture-unknown', effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: undefined, vocabulary: [] })) === '{"stream_options":{"include_usage":true}}')
  mode = 'tools'
  const tools = await run(params('grok-4.7'))
  const calls = tools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use')
  check('fragmented function arguments become one executable call', calls.length === 1 && calls[0]?.type === 'tool_use' && calls[0].id === 'call_fixture' && JSON.stringify(calls[0].input) === '{"text":"hello"}')
  mode = 'text'
  await run(params('grok-4.7', 'high', true, [...tools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'echo:hello' }] })]))
  const history = captures.at(-1)!.body.messages
  check('tool result pairs to its assistant call on the next request', history.some((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'call_fixture') && history.some((row: any) => row.role === 'tool' && row.tool_call_id === 'call_fixture'))
  check('Chat Completions never replays Responses-only ciphertext or a borrowed reasoning-history contract', history.every((row: any) => !('reasoning_content' in row) && !('encrypted_content' in row)))
  mode = 'malformed'
  const malformed = await run(params('grok-4.7'))
  check('malformed tool JSON never becomes an executable call', !malformed.some(row => row.message.content.some(block => block.type === 'tool_use')))
  mode = 'auth'
  const beforeAuth = captures.length
  const auth = await run(params('grok-4.7'))
  check('authentication failure refuses once with the xAI remedy', captures.length === beforeAuth + 1 && auth.some(row => row.isApiErrorMessage && JSON.stringify(row).includes('/logins xai')))
  mode = 'billing'
  await run(params('grok-4.7'))
  check('billing refusal lands on the xAI billing state', laneBillingState('xai').state === 'credit-exhausted')
  mode = 'busy'
  const beforeBusy = captures.length
  const busy = await run(params('grok-4.7'))
  check('provider overload retries on its own lane and settles', captures.length === beforeBusy + 2 && busy.some(row => !row.isApiErrorMessage))
  check('a successful turn clears that lane billing refusal', laneBillingState('xai').state === 'clear')
  const beforeAbsent = captures.length
  const absent = await run(params('grok-fixture-absent'))
  check('an id missing from the fetched list refuses before chat', captures.length === beforeAbsent && absent.some(row => row.isApiErrorMessage && JSON.stringify(row).includes('not offered')))
  modelList = []; await refreshXaiCatalogue({ force: true })
  const empty = await run(params('grok'))
  check('empty live list refuses an unresolved family alias, never sends a pin', captures.length === beforeAbsent && empty.some(row => row.isApiErrorMessage))
  const abort = new AbortController(); abort.abort()
  const cancelled = await run({ ...params(), signal: abort.signal })
  check('pre-aborted calls return quietly with no chat request', cancelled.length === 0 && captures.length === beforeAbsent)
  const { __resetXaiCatalogueForTest } = await import('../../src/services/providers/xai/xaiCatalogue.ts')
  __resetXaiCatalogueForTest()
  let releaseList: () => void = () => {}
  holdList = new Promise<void>(resolve => { releaseList = resolve })
  const entered = new Promise<void>(resolve => { listEntered = resolve })
  const duringList = new AbortController()
  const waiting = run({ ...params(), signal: duringList.signal })
  await entered
  const pendingList = refreshXaiCatalogue()
  duringList.abort()
  let deadline: ReturnType<typeof setTimeout> | undefined
  const interrupted = await Promise.race([waiting, new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), 1_000) })])
  clearTimeout(deadline)
  releaseList(); await pendingList
  check('cancellation during discovery does not wait for the catalogue bound', interrupted !== null && interrupted.length === 0 && captures.length === beforeAbsent)
  const oauth = await import('../../src/services/providers/xai/xaiOauth.ts')
  holdList = undefined; listEntered = undefined
  modelList = [{ id: 'grok-4.7', created: 7 }]
  oauth.writeXaiTokens({ accessToken: 'fixture-subscription-access', refreshToken: 'fixture-subscription-refresh', expiresAtMs: Date.now() + 3600_000 })
  oauth.writePreferredXaiSource('grok-subscription')
  delete process.env.XAI_API_KEY
  check('the subscription alone admits the primary backend without any API key', resolvePrimaryAgentBackend('grok-4.7')?.readiness().state !== 'unavailable')
  const keyListPaths = listPaths.length
  mode = 'tools'
  const subscriptionTools = await run(params('grok-4.7'))
  const subscriptionBody = captures.at(-1)!.body
  check('the subscription lists on the Grok proxy with its bearer, never on the API-key base', listPaths.slice(keyListPaths).length >= 1 && listPaths.slice(keyListPaths).every(row => row.path === '/proxy/v1/models' && row.bearer === 'Bearer fixture-subscription-access') && listPaths.slice(0, keyListPaths).every(row => row.path === '/v1/models'))
  check('subscription bearer rides the Grok proxy Responses road with the CLI identity headers OpenClaw sends', captures.at(-1)?.path === '/proxy/v1/responses' && captures.at(-1)?.bearer && captures.at(-1)?.headers['x-xai-token-auth'] === 'xai-grok-cli' && captures.at(-1)?.headers['x-grok-model-override'] === 'grok-4.7' && captures.at(-1)?.headers['x-grok-client-version'] === '2026.9.7')
  check('subscription uses flat function tools, typed input and stateless encrypted reasoning', subscriptionBody.tools[0].name === 'FixtureEcho' && !subscriptionBody.tools[0].function && !('defer_loading' in subscriptionBody.tools[0]) && subscriptionBody.tools.every((tool: any) => tool.type === 'function') && Array.isArray(subscriptionBody.input) && subscriptionBody.store === false && subscriptionBody.include.includes('reasoning.encrypted_content'))
  const { foldSplitTurnsForWire } = await import('../../src/utils/messages/pairing.ts')
  check('wire normalization preserves the xAI replay record', foldSplitTurnsForWire(subscriptionTools).some(row => row.type === 'assistant' && row.xaiProviderTurn?.items.length === 2))
  check('subscription tool call settles with its own provider replay record', subscriptionTools.some(row => row.message.content.some(block => block.type === 'tool_use' && block.id === 'call_sub')) && subscriptionTools.at(-1)?.xaiProviderTurn?.items.length === 2)
  mode = 'text'
  const subText = await run(params('grok-4.7', 'high', true, [...subscriptionTools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_sub', content: 'subscription result' }] })]))
  const input = captures.at(-1)!.body.input
  check('subscription replay preserves encrypted reasoning and pairs tool output by call id as a string the proxy accepts', input.some((row: any) => row.type === 'reasoning' && row.encrypted_content === 'fixture-encrypted') && input.some((row: any) => row.type === 'function_call_output' && row.call_id === 'call_sub' && row.output === 'subscription result'))
  check('subscription Responses text and usage settle under xAI', subText.some(row => JSON.stringify(row.message.content).includes('GROK-SUBSCRIPTION-SETTLED')) && subText.at(-1)?.message.usage?.output_tokens === 10)
  const { xaiProxyToolOutputs } = await import('../../src/services/providers/xai/xaiResponsesTransport.ts')
  const rehomed = xaiProxyToolOutputs([
    { type: 'function_call_output', call_id: 'call_a', output: [{ type: 'input_text', text: 'shot taken' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    { type: 'function_call_output', call_id: 'call_b', output: 'plain' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
  ]) as Array<Record<string, any>>
  check('an image-bearing tool result rides the proxy as a string output with its image re-homed in one user message after the paired outputs, the way OpenClaw sends it', rehomed.length === 4 && rehomed[0]?.output === 'shot taken' && rehomed[1]?.output === 'plain' && rehomed[2]?.type === 'message' && rehomed[2].role === 'user' && rehomed[2].content[0].text === 'Image(s) from tool result call_a:' && rehomed[2].content[1].type === 'input_image' && rehomed[3]?.content[0].text === 'next')
  oauth.clearStoredXaiSubscription()
  console.log(`XAI WIRE GREEN (${checks} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
