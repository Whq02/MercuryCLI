import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import { MISTRAL_FIXTURE_MODELS } from '../providers/lib/mistral-fixture.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MISTRAL_API_KEY = 'proof-key-mistral-wire-fixture-not-a-real-key'
let mode: 'text' | 'tools' | 'malformed' | 'auth' | 'billing' | 'busy' | 'truncated' | 'invalid' = 'text'
let modelList: unknown[] = MISTRAL_FIXTURE_MODELS
const captures: Array<{ path: string; body: Record<string, any>; bearer: boolean }> = []
let listReads = 0
let holdList: Promise<void> | undefined
let listEntered: (() => void) | undefined
const sse = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (path === '/v1/models') { listReads++; listEntered?.(); await holdList; return Response.json({ object: 'list', data: modelList }) }
  assert.equal(path, '/v1/chat/completions')
  assert.equal(req.method, 'POST')
  const raw = await req.text()
  assert.ok(!raw.includes(process.env.MISTRAL_API_KEY!))
  const body = JSON.parse(raw)
  captures.push({ path, body, bearer: req.headers.get('authorization') === `Bearer ${process.env.MISTRAL_API_KEY}` })
  if (mode === 'auth' || mode === 'billing' || mode === 'busy') {
    const status = mode === 'auth' ? 401 : mode === 'billing' ? 402 : 503
    if (mode === 'busy') mode = 'text'
    return Response.json({ object: 'error', message: status === 503 ? 'Service unavailable' : status === 402 ? 'Monthly usage limit reached' : 'Unauthorized', type: status === 503 ? 'server_error' : status === 402 ? 'rate_limit_error' : 'authentication_error', param: null, code: status === 401 ? 'invalid_api_key' : null }, { status, headers: { 'x-should-retry': 'false' } })
  }
  if (mode === 'invalid') return Response.json({ object: 'error', message: 'Unsupported parameter: top_p', type: 'invalid_request_error', param: 'top_p', code: 'unsupported_parameter' }, { status: 422 })
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown): string => sse({ id: 'mistral-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })
  let stream = chunk({ role: 'assistant', content: '' })
  if (mode === 'tools' || mode === 'malformed') {
    stream += chunk({ tool_calls: [{ index: 0, id: 'fixtur123', type: 'function', function: { name: 'FixtureEcho', arguments: mode === 'malformed' ? '{broken' : '{"text":' } }] })
    if (mode === 'tools') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] })
    stream += chunk({}, 'tool_calls', { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 })
  } else {
    if (body.reasoning_effort === 'high') {
      stream += chunk({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Weighing the fixture' }] }] })
      stream += chunk({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: ' carefully.' }], closed: true }, { type: 'text', text: 'MISTRAL-' }] })
    }
    stream += chunk({ content: 'FIXTURE-SETTLED' })
    if (mode !== 'truncated') stream += chunk({}, 'stop', { prompt_tokens: 32, completion_tokens: 103, total_tokens: 135, prompt_tokens_details: { cached_tokens: 4 } })
  }
  if (mode === 'truncated') return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  return new Response(stream + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MERCURY_MISTRAL_API_BASE = `http://127.0.0.1:${server.port}/v1`
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
const { refreshMistralCatalogue, __resetMistralCatalogueForTest } = await import('../../src/services/providers/mistral/mistralCatalogue.ts')
const { buildMistralExtras } = await import('../../src/services/providers/mistral/mistralCallModel.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
const { classifyModelRoute } = await import('../../src/services/providers/routeLaw.ts')
const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
function params(model = 'mistral', effortValue: string | undefined = 'max', thinking = true, messages: Message[] = [createUserMessage({ content: 'hello fixture' })]): CompatCallModelParams {
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
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  check('the bare prefixes and the family word route to Mistral and nowhere else', ['mistral-large-4', 'ministral-8b-2512', 'codestral-latest', 'mistral'].every(id => classifyModelRoute(parseUserSpecifiedModel(id)).route === 'mistral') && classifyModelRoute(parseUserSpecifiedModel('openrouter/mistral/mistral-fixture-bare')).route === 'openrouter')
  check('the key configures a Mistral backend but is not a claimed live turn', resolvePrimaryAgentBackend('mistral-large-4')?.id === 'mistral-chat' && resolvePrimaryAgentBackend('mistral')?.readiness().state === 'configured' && resolveProviderUsability().mistral.usable)
  const first = await run()
  const body = captures[0]!.body
  check('the family word reads the account list once and selects Large 4, the first served pin', listReads === 1 && body.model === 'mistral-large-4' && captures[0]?.bearer)
  check('the chat request carries function tools, auto choice and streaming, with no stream_options (Mistral states usage on the final chunk)', body.stream === true && !('stream_options' in body) && body.tools[0].function.name === 'FixtureEcho' && body.tool_choice === 'auto')
  check('thinking on sends reasoning_effort high, the vendor word for a visible thinking chunk, and no foreign thinking field', body.reasoning_effort === 'high' && !('thinking' in body) && !('reasoning' in body) && !('input' in body))
  check('an explicit output override rides max_tokens; sampling stays at the provider defaults', body.max_tokens === 512 && !('max_completion_tokens' in body) && !('temperature' in body) && !('top_p' in body))
  check('the chunk-list thinking decodes as a thinking block and the transition chunk loses no visible text', thinkingOf(first) === 'Weighing the fixture carefully.' && textOf(first) === 'MISTRAL-FIXTURE-SETTLED')
  const usage = first.at(-1)?.message.usage
  check('cached input tokens and completion tokens settle once from the final chunk', usage?.input_tokens === 28 && usage.cache_read_input_tokens === 4 && usage.output_tokens === 103)
  check('a settled turn alone advances the readiness receipt', resolvePrimaryAgentBackend('mistral')?.readiness().state === 'ready')
  const off = await run(params('mistral-large-4', 'max', false))
  check('thinking off sends reasoning_effort none and the reply carries no thinking block', captures.at(-1)?.body.reasoning_effort === 'none' && thinkingOf(off) === '' && textOf(off) === 'FIXTURE-SETTLED')
  await run(params('mistral-medium-3-5', 'low', true))
  check('every thinking-on effort rung is the same vendor word on a two-word dial — low is never turned into none', captures.at(-1)?.body.reasoning_effort === 'high')
  await run(params('codestral-2508', 'max', true))
  check('a model the vendor lists without reasoning sends no reasoning_effort at all', !('reasoning_effort' in captures.at(-1)!.body) && captures.at(-1)?.body.model === 'codestral-2508')
  await run(params('mistral-large-latest'))
  check('a vendor alias dispatches as the listed row it names (mistral-large-latest is Large 3 today)', captures.at(-1)?.body.model === 'mistral-large-2512')
  check('unknown model facts invent neither an effort nor an output ceiling', JSON.stringify(buildMistralExtras({ wireModel: 'mistral-fixture-unknown', effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: undefined })) === '{}')
  const structured = params('mistral-large-4')
  structured.options.outputFormat = { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }
  await run(structured)
  check('structured output uses response_format with the original schema, never text.format', captures.at(-1)?.body.response_format.type === 'json_schema' && JSON.stringify(captures.at(-1)?.body.response_format.json_schema.schema) === JSON.stringify(structured.options.outputFormat.schema) && !('text' in captures.at(-1)!.body))
  mode = 'tools'
  const tools = await run(params('mistral-large-4'))
  const calls = tools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use')
  check('fragmented tool arguments become one validated executable call under the provider id', calls.length === 1 && calls[0]?.type === 'tool_use' && calls[0].id === 'fixtur123' && JSON.stringify(calls[0].input) === '{"text":"hello"}')
  mode = 'text'
  await run(params('mistral-large-4', 'high', true, [...tools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'fixtur123', content: 'echo:hello' }] })]))
  const history = captures.at(-1)!.body.messages
  check('tool results replay with the matching assistant call and no private reasoning', history.some((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'fixtur123') && history.some((row: any) => row.role === 'tool' && row.tool_call_id === 'fixtur123') && history.every((row: any) => !('reasoning_content' in row)))
  mode = 'malformed'
  check('malformed tool JSON cannot become an executable call', !(await run()).some(row => row.message.content.some(block => block.type === 'tool_use')))
  mode = 'truncated'
  check('an unterminated stream does not count as success', (await run()).some(row => row.isApiErrorMessage))
  mode = 'auth'
  const beforeAuth = captures.length
  const auth = await run()
  check('an invalid key refuses once with the Mistral remedy', captures.length === beforeAuth + 1 && auth.some(row => row.isApiErrorMessage && JSON.stringify(row).includes('/logins mistral')))
  mode = 'invalid'
  check('a vendor 422 validation error settles as a typed refusal without an overflow stamp', (await run()).every(row => row.overflowSignal === undefined) && captures.at(-1)?.body.model === 'mistral-large-4')
  mode = 'billing'; await run()
  check('a billing refusal belongs to Mistral, not another family', laneBillingState('mistral').state === 'credit-exhausted')
  mode = 'busy'
  const beforeBusy = captures.length
  await run()
  check('a provider overload retries its own lane then clears its billing state', captures.length === beforeBusy + 2 && laneBillingState('mistral').state === 'clear')
  const dispatch = await resolveEngineDispatch('mistral')
  check("the Agent class word 'mistral' selects the same served Large 4 row", dispatch?.backend === 'mistral' && dispatch.model === 'mistral-large-4')
  const beforeAbsent = captures.length
  check('off-list, retired and non-chat ids refuse before inference like any unknown input', (await run(params('mistral-fixture-absent'))).some(row => row.isApiErrorMessage) && (await run(params('mistral-medium-2508'))).some(row => row.isApiErrorMessage) && (await run(params('mistral-embed'))).some(row => row.isApiErrorMessage) && captures.length === beforeAbsent)
  modelList = []; await refreshMistralCatalogue({ force: true })
  check("an empty list refuses 'mistral' rather than sending a pin", (await run()).some(row => row.isApiErrorMessage) && captures.length === beforeAbsent)
  await refreshMistralCatalogue({ force: true, fetchImpl: (async () => Response.json({ object: 'error', message: 'Unauthorized' }, { status: 401 })) as typeof fetch })
  const refusedAlias = await run()
  check("a catalogue auth refusal remains an auth refusal even when 'mistral' has no row", refusedAlias.some(row => row.isApiErrorMessage && row.error === 'authentication_failed' && JSON.stringify(row).includes('HTTP 401') && JSON.stringify(row).includes('/logins mistral')) && captures.length === beforeAbsent)
  const aborted = new AbortController(); aborted.abort()
  check('pre-aborted calls return quietly without a chat request', (await run({ ...params(), signal: aborted.signal })).length === 0 && captures.length === beforeAbsent)
  __resetMistralCatalogueForTest()
  let releaseList: () => void = () => {}
  holdList = new Promise<void>(resolve => { releaseList = resolve })
  const entered = new Promise<void>(resolve => { listEntered = resolve })
  const duringList = new AbortController()
  const waiting = run({ ...params(), signal: duringList.signal })
  await entered
  const pendingList = refreshMistralCatalogue()
  duringList.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  const interrupted = await Promise.race([waiting, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1_000) })])
  clearTimeout(timer)
  releaseList(); await pendingList
  check('abort during discovery does not wait for the catalogue bound', interrupted !== null && interrupted.length === 0 && captures.length === beforeAbsent)
  console.log(`MISTRAL WIRE GREEN (${count} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
