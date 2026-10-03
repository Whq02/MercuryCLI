import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MODEL_API_KEY = 'meta-fixture-wire-not-a-real-key'
const META_OVERFLOW_BODY = { error: { message: "You passed 1200064 input tokens and requested 1 output tokens. However, the model's context length is only 1048576 tokens, resulting in a maximum input length of 1048575 tokens. Please reduce the length of the input prompt", type: 'invalid_request_error', code: null, param: null } }
let mode: 'text' | 'tools' | 'malformed' | 'auth' | 'billing' | 'busy' | 'truncated' | 'overflow' | 'invalid' = 'text'
let modelList: unknown[] = [{ id: 'muse-spark-1.3', created: 3 }, { id: 'muse-spark-1.2', created: 2 }, { id: 'muse-spark-1.3-contributor', created: 4 }]
const captures: Array<{ path: string; body: Record<string, any>; bearer: boolean }> = []
let listReads = 0
let holdList: Promise<void> | undefined
let listEntered: (() => void) | undefined
const sse = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (path === '/v1/models') { listReads++; listEntered?.(); await holdList; return Response.json({ data: modelList }) }
  assert.equal(path, '/v1/chat/completions')
  assert.equal(req.method, 'POST')
  const raw = await req.text()
  assert.ok(!raw.includes(process.env.MODEL_API_KEY!))
  const body = JSON.parse(raw)
  captures.push({ path, body, bearer: req.headers.get('authorization') === `Bearer ${process.env.MODEL_API_KEY}` })
  if (mode === 'auth' || mode === 'billing' || mode === 'busy') {
    const status = mode === 'auth' ? 401 : mode === 'billing' ? 402 : 503
    if (mode === 'busy') mode = 'text'
    return Response.json({ error: { message: status === 503 ? 'provider overloaded' : status === 402 ? 'insufficient balance' : 'invalid API key' } }, { status, headers: { 'x-should-retry': 'false' } })
  }
  if (mode === 'overflow') return Response.json(META_OVERFLOW_BODY, { status: 400 })
  if (mode === 'invalid') return Response.json({ error: { message: 'Unsupported parameter: top_p', type: 'invalid_request_error', code: null, param: 'top_p' } }, { status: 400 })
  const chunk = (delta: unknown, finish: string | null = null): string => sse({ id: 'meta-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
  let stream = chunk({ role: 'assistant', reasoning_content: '' })
  if (mode === 'tools' || mode === 'malformed') {
    stream += chunk({ tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'FixtureEcho', arguments: mode === 'malformed' ? '{broken' : '{"text":' } }] })
    if (mode === 'tools') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] })
    stream += chunk({}, 'tool_calls')
  } else {
    stream += chunk({ content: 'MUSE-FIXTURE-SETTLED' })
    if (mode !== 'truncated') stream += chunk({}, 'stop')
  }
  if (mode === 'truncated') return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  stream += sse({ choices: [], usage: { prompt_tokens: 32, completion_tokens: 103, total_tokens: 135, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 94 } } })
  return new Response(stream + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MERCURY_META_API_BASE = `http://127.0.0.1:${server.port}/v1`
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
const { refreshMetaCatalogue, __resetMetaCatalogueForTest } = await import('../../src/services/providers/meta/metaCatalogue.ts')
const { buildMetaExtras } = await import('../../src/services/providers/meta/metaCallModel.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
function params(model = 'muse', effortValue: string | undefined = 'max', thinking = true, messages: Message[] = [createUserMessage({ content: 'hello fixture' })]): CompatCallModelParams {
  return { messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: thinking ? { type: 'enabled', budgetTokens: 4096 } : { type: 'disabled' }, signal: new AbortController().signal,
    options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue, maxOutputTokensOverride: 512 } as never }
}
async function run(p = params()): Promise<AssistantMessage[]> {
  const settled: AssistantMessage[] = []
  for await (const event of routedCallModel(p as never)) if (event.type === 'assistant') settled.push(event as AssistantMessage)
  return settled
}
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  check('the key configures a Meta backend but is not a claimed live turn', resolvePrimaryAgentBackend('muse-spark-1.3')?.id === 'meta-chat' && resolvePrimaryAgentBackend('muse')?.readiness().state === 'configured' && resolveProviderUsability().meta.usable)
  const first = await run()
  const body = captures[0]!.body
  check('alias dispatch reads the account list and selects Standard rather than a newer Contributor row', listReads === 1 && body.model === 'muse-spark-1.3' && captures[0]?.bearer)
  check('chat request carries function tools, auto choice and streaming usage', body.stream && body.stream_options.include_usage && body.tools[0].function.name === 'FixtureEcho' && body.tool_choice === 'auto')
  check('Standard 1.3 sends max without foreign thinking or Responses fields', body.reasoning_effort === 'max' && !('thinking' in body) && !('input' in body) && !('reasoning' in body))
  check('explicit output override is max_completion_tokens; sampling stays at Meta defaults', body.max_completion_tokens === 512 && !('max_tokens' in body) && !('temperature' in body) && !('top_p' in body))
  check('visible text settles without invented private reasoning', first.some(row => row.message.content.some(block => block.type === 'text' && block.text.includes('MUSE-FIXTURE-SETTLED'))) && !first.some(row => row.message.content.some(block => block.type === 'thinking')))
  const usage = first.at(-1)?.message.usage
  check('cached input and reasoning-inclusive completion tokens settle once', usage?.input_tokens === 28 && usage.cache_read_input_tokens === 4 && usage.output_tokens === 103)
  check('a settled turn alone advances the readiness receipt', resolvePrimaryAgentBackend('muse')?.readiness().state === 'ready')
  await run(params('muse-spark-1.2', 'max'))
  check('older rows clamp to their documented xhigh effort', captures.at(-1)?.body.reasoning_effort === 'xhigh')
  await run(params('muse-spark-1.3-contributor', 'max', false))
  check('Contributor never sends max or an unsupported reasoning-off flag', captures.at(-1)?.body.reasoning_effort === 'xhigh' && !('thinking' in captures.at(-1)!.body))
  check('unknown model facts invent neither an effort nor an output ceiling', JSON.stringify(buildMetaExtras({ wireModel: 'muse-spark-fixture-unknown', effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: undefined })) === '{"stream_options":{"include_usage":true}}')
  const structured = params('muse-spark-1.3')
  structured.options.outputFormat = { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }
  await run(structured)
  check('structured output uses response_format with the original schema, never text.format', captures.at(-1)?.body.response_format.type === 'json_schema' && JSON.stringify(captures.at(-1)?.body.response_format.json_schema.schema) === JSON.stringify(structured.options.outputFormat.schema) && !('text' in captures.at(-1)!.body))
  mode = 'tools'
  const tools = await run(params('muse-spark-1.3'))
  const calls = tools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use')
  check('fragmented tool arguments become one validated executable call', calls.length === 1 && calls[0]?.type === 'tool_use' && calls[0].id === 'call_fixture' && JSON.stringify(calls[0].input) === '{"text":"hello"}')
  mode = 'text'
  await run(params('muse-spark-1.3', 'high', true, [...tools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'echo:hello' }] })]))
  const history = captures.at(-1)!.body.messages
  check('tool results replay with the matching assistant call and no private reasoning', history.some((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'call_fixture') && history.some((row: any) => row.role === 'tool' && row.tool_call_id === 'call_fixture') && history.every((row: any) => !('reasoning_content' in row) && !('encrypted_content' in row)))
  mode = 'malformed'
  check('malformed tool JSON cannot become an executable call', !(await run()).some(row => row.message.content.some(block => block.type === 'tool_use')))
  mode = 'truncated'
  check('an unterminated stream does not count as success', (await run()).some(row => row.isApiErrorMessage))
  mode = 'auth'
  const beforeAuth = captures.length
  const auth = await run()
  check('an invalid key refuses once with the Meta remedy', captures.length === beforeAuth + 1 && auth.some(row => row.isApiErrorMessage && JSON.stringify(row).includes('/logins meta')))
  mode = 'overflow'
  const beforeOverflow = captures.length
  const overflow = await run()
  check('the documented null-code Meta 400 stamps an input overflow once for emergency folding', captures.length === beforeOverflow + 1 && overflow.some(row => row.isApiErrorMessage && row.overflowSignal?.family === 'meta' && row.overflowSignal.shape === 'context-length-exceeded' && row.overflowSignal.actualTokens === 1_200_064 && row.overflowSignal.limitTokens === 1_048_575))
  mode = 'invalid'
  check('an unrelated Meta invalid-request 400 carries no overflow stamp', (await run()).every(row => row.overflowSignal === undefined))
  mode = 'billing'; await run()
  check('billing refusal belongs to Meta, not another family', laneBillingState('meta').state === 'credit-exhausted')
  mode = 'busy'
  const beforeBusy = captures.length
  await run()
  check('a provider overload retries its own lane then clears its billing state', captures.length === beforeBusy + 2 && laneBillingState('meta').state === 'clear')
  const dispatch = await resolveEngineDispatch('muse')
  check('the Agent class alias selects the same live Standard model', dispatch?.backend === 'meta' && dispatch.model === 'muse-spark-1.3')
  const beforeAbsent = captures.length
  check('off-list and non-chat ids refuse before inference', (await run(params('muse-spark-fixture-absent'))).some(row => row.isApiErrorMessage) && (await run(params('muse-image-1.0'))).some(row => row.isApiErrorMessage) && captures.length === beforeAbsent)
  modelList = []; await refreshMetaCatalogue({ force: true })
  check('an empty list refuses muse rather than sending a pin', (await run()).some(row => row.isApiErrorMessage) && captures.length === beforeAbsent)
  await refreshMetaCatalogue({ force: true, fetchImpl: (async () => Response.json({}, { status: 401 })) as typeof fetch })
  const refusedAlias = await run()
  check('a catalogue auth refusal remains an auth refusal even when muse has no row', refusedAlias.some(row => row.isApiErrorMessage && row.error === 'authentication_failed' && JSON.stringify(row).includes('HTTP 401') && JSON.stringify(row).includes('/logins meta')) && captures.length === beforeAbsent)
  const aborted = new AbortController(); aborted.abort()
  check('pre-aborted calls return quietly without a chat request', (await run({ ...params(), signal: aborted.signal })).length === 0 && captures.length === beforeAbsent)
  __resetMetaCatalogueForTest()
  let releaseList: () => void = () => {}
  holdList = new Promise<void>(resolve => { releaseList = resolve })
  const entered = new Promise<void>(resolve => { listEntered = resolve })
  const duringList = new AbortController()
  const waiting = run({ ...params(), signal: duringList.signal })
  await entered
  const pendingList = refreshMetaCatalogue()
  duringList.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  const interrupted = await Promise.race([waiting, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1_000) })])
  clearTimeout(timer)
  releaseList(); await pendingList
  check('abort during discovery does not wait for the catalogue bound', interrupted !== null && interrupted.length === 0 && captures.length === beforeAbsent)
  console.log(`META WIRE GREEN (${count} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
