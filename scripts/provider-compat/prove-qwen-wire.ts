import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { z } from 'zod/v4'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'ANTHROPIC_BASE_URL', 'DASHSCOPE_BASE_URL', 'DASHSCOPE_WORKSPACE_ID']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BUSY_RETRY_SCALE = '0.2'
const KEY_INTL = 'proof-key-qwen-singapore-fixture-not-a-real-key'
const KEY_CN = 'proof-key-qwen-beijing-fixture-not-a-real-key'
const KEY_CODING = 'sk-sp-proof-key-qwen-coding-fixture-not-a-real-key'
const KEY_CODING_CN = 'sk-sp-proof-key-qwen-coding-cn-fixture-not-a-real-key'
const KEY_QWENCLOUD_TOKEN = 'sk-sp-proof-key-qwencloud-token-plan-fixture-not-a-real-key'
const KEY_CODING_NOWHERE = 'sk-sp-proof-key-qwen-coding-nowhere-fixture-not-a-real-key'
const KEY_WORKSPACE = 'proof-key-qwen-virginia-workspace-fixture-not-a-real-key'
const KEY_NOWHERE = 'proof-key-qwen-nowhere-fixture-not-a-real-key'
const KEY_QWENCLOUD = 'proof-key-qwencloud-payg-fixture-not-a-real-key'
const ACCEPTS: Record<string, string> = { [KEY_INTL]: 'singapore', [KEY_CN]: 'beijing', [KEY_CODING]: 'coding-intl', [KEY_CODING_CN]: 'coding-cn', [KEY_QWENCLOUD_TOKEN]: 'qwencloud-token-plan', [KEY_WORKSPACE]: 'workspace-virginia', [KEY_QWENCLOUD]: 'qwencloud' }
const CODING_ENDPOINTS = new Set(['coding-intl', 'coding-cn'])
const CODING_PUBLIC_LIST = ['qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus']
const QWENCLOUD_TOKEN_PLAN_LIST = ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen-audio-3.0-asr-flash', 'glm-5.2', 'deepseek-v4-pro', 'wan2.7-image', 'wan2.7-image-pro']
const CODING_PLAN_ROWS = ['qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-flash', 'qwen3.6-flash', 'qwen-auto']
const PAY_AS_YOU_GO_PINS = ['qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-flash', 'qwen3.8-omni-flash', 'qwen3.7-flash', 'qwen3.6-flash', 'qwen3-coder-flash']
const oauthCalls: string[] = []
process.env.DASHSCOPE_API_KEY = KEY_INTL
const liveRows = (ids: string[]): unknown[] => ids.map(id => ({ id, object: 'model', created: 1, owned_by: 'system' }))
const TEXT_IDS = ['qwen3.8-max', 'qwen3.7-plus', 'qwen3-coder-plus', 'qwen3.8-flash', 'qwen3.7-flash', 'qwen3-coder-flash', 'qwen3.8-omni-flash', 'qwen-plus']
const OTHER_IDS = ['qwen3.7-text-embedding', 'qwen3-rerank', 'qwen-audio-3.0-tts-plus', 'wan3.0-video', 'qwen3.8-omni-flash-realtime', 'deepseek-v4-pro', 'kimi-k3', 'MiniMax-M2.5', 'glm-5.2']
const fixtures = liveRows([...TEXT_IDS, ...OTHER_IDS])
let modelList: unknown[] = fixtures
let listStatus = 200
let boundRefusesChat = false
let mode = 'text'
const listReads: string[] = []
const captures: Array<{ endpoint: string; body: Record<string, any>; bearer: string | null }> = []
const refuse = (status: number, code: string, message: string, headers: Record<string, string> = {}): Response => Response.json({ error: { message, type: 'invalid_request_error', param: null, code } }, { status, headers })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url)
  const [, endpoint, ...rest] = url.pathname.split('/')
  const path = `/${rest.join('/')}`
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null
  const accepted = bearer !== null && ACCEPTS[bearer] === endpoint
  if (path === '/models') {
    listReads.push(endpoint!)
    if (CODING_ENDPOINTS.has(endpoint!)) return Response.json({ object: 'list', data: liveRows(CODING_PUBLIC_LIST) })
    if (endpoint === 'qwencloud-token-plan') {
      if (!accepted || listStatus === 401) return Response.json({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, { status: 401 })
      return Response.json({ first_id: 'model-id-0', data: liveRows(QWENCLOUD_TOKEN_PLAN_LIST) })
    }
    if (!accepted || listStatus === 401) return refuse(401, 'invalid_api_key', 'Incorrect API key provided. ')
    if (listStatus !== 200) return refuse(listStatus, 'server_error', 'unavailable')
    return Response.json({ object: 'list', data: modelList })
  }
  if (url.pathname.startsWith('/api/v1/oauth2/')) { oauthCalls.push(url.pathname); return new Response('not found', { status: 404 }) }
  if (path !== '/chat/completions' || req.method !== 'POST') return new Response('not found', { status: 404 })
  const raw = await req.text()
  for (const key of Object.keys(ACCEPTS)) assert.ok(!raw.includes(key))
  const body = JSON.parse(raw) as Record<string, any>
  captures.push({ endpoint: endpoint!, body, bearer })
  if (!accepted && endpoint === 'qwencloud-token-plan') return refuse(401, 'invalid_api_key', 'Invalid API-key provided.')
  if (!accepted && CODING_ENDPOINTS.has(endpoint!)) return refuse(401, 'invalid_api_key', 'invalid access token or token expired')
  if (!accepted || boundRefusesChat || mode === 'auth') return refuse(401, 'invalid_api_key', 'Incorrect API key provided. ')
  for (const forbidden of ['max_completion_tokens', 'reasoning', 'thinking', 'temperature', 'top_p']) if (forbidden in body) return refuse(400, 'invalid_parameter', `unsupported parameter ${forbidden}`)
  if ('reasoning_effort' in body && 'thinking_budget' in body) return refuse(400, 'invalid_parameter', 'reasoning_effort and thinking_budget cannot be set at the same time')
  if ('reasoning_effort' in body && (!/^qwen3\.8-(?:max|flash|omni-flash|2\.4t-a95b|27b)/.test(body.model) || !['low', 'medium', 'xhigh'].includes(body.reasoning_effort))) return refuse(400, 'invalid_parameter', `reasoning_effort ${body.reasoning_effort} on ${body.model}`)
  if ('thinking_budget' in body && !(Number.isInteger(body.thinking_budget) && body.thinking_budget > 0)) return refuse(400, 'invalid_parameter', 'thinking_budget')
  if (body.messages.some((row: any, index: number) => row.role === 'system' && index !== 0)) return refuse(400, 'invalid_parameter', 'only messages[0] takes the system role')
  if (/^qwen3-coder-plus/.test(body.model) && ('enable_thinking' in body || 'preserve_thinking' in body)) return refuse(400, 'invalid_parameter', 'thinking knobs on a non-thinking model')
  if (body.model === 'qwen-plus' && 'preserve_thinking' in body) return refuse(400, 'invalid_parameter', 'preserve_thinking on a row that does not take it')
  if (mode === 'billing') return refuse(400, 'Arrearage', 'Access denied, please make sure your account is in good standing.')
  if (mode === 'rate') return refuse(429, 'rate_limit_exceeded', 'Requests rate limit exceeded, please try again later.', { 'retry-after': '3600' })
  if (mode === 'busy') { mode = 'text'; return refuse(503, 'server_error', 'The server is overloaded.') }
  const chunk = (delta: unknown, finish: string | null = null, extra = {}): string => `data: ${JSON.stringify({ id: 'chatcmpl-qwen-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null, ...(mode === 'misplaced' ? { reasoning_content: 'wrong place' } : {}) }], usage: null, ...extra })}\n\n`
  let stream = chunk({ role: 'assistant', content: null, reasoning_content: '' })
  const thinks = body.enable_thinking === true
  if (mode === 'tools' || mode === 'malformed') {
    if (thinks) stream += chunk({ reasoning_content: 'Calling the fixture tool.' })
    stream += chunk({ tool_calls: [{ index: 0, id: 'call_qwen_fixture_1', type: 'function', function: { name: 'FixtureEcho', arguments: mode === 'malformed' ? '{broken' : '{"text":' } }] })
    if (mode === 'tools') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] })
    stream += chunk({}, 'tool_calls')
  } else {
    if (thinks && mode !== 'misplaced') { stream += chunk({ reasoning_content: 'Weighing the fixture' }); stream += chunk({ reasoning_content: ' carefully.' }) }
    stream += chunk({ content: 'QWEN-' })
    stream += chunk({ content: 'FIXTURE-SETTLED' })
    if (mode !== 'truncated') stream += chunk({ content: '', reasoning_content: null }, 'stop')
  }
  if (mode === 'truncated') return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  stream += `data: ${JSON.stringify({ id: 'chatcmpl-qwen-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 32, completion_tokens: 103, total_tokens: 135, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 9 } } })}\n\ndata: [DONE]\n\n`
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
} })
const seam = `http://127.0.0.1:${server.port}`
process.env.MERCURY_QWEN_API_BASE = seam
process.env.MERCURY_GROQ_API_BASE = `${seam}/groq-fixture/openai/v1`
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
const section = (name: string): void => console.log(`\n── ${name}`)
try {
  const { classifyModelRoute } = await import('../../src/services/providers/routeLaw.ts')
  const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
  section('routing')
  check('the bare Model Studio ids and the family word route to Qwen before any request', ['qwen3.8-max', 'qwen3.7-plus', 'qwen3-coder-flash', 'qwen-plus', 'qwq-plus', 'qwen', 'Qwen3.8-Max'].every(id => classifyModelRoute(parseUserSpecifiedModel(id)).route === 'qwen'))
  check('the qualified namespaces keep their own Qwen rows and a bare vendor slug stays carrier-shaped', classifyModelRoute('zen/qwen3.8-max').route === 'zen' && classifyModelRoute('groq/qwen/qwen3.8-27b').route === 'groq' && classifyModelRoute('together/Qwen/Qwen3.7-Plus').route === 'together' && classifyModelRoute('qwen/qwen3-coder').kind === 'unrecognised')
  const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
  const { QWEN_SHARED_ENDPOINTS, qwenProbeEndpoints, qwenEndpointBase, qwenBoundBase, forgetQwenBoundBases, qwenUnboundKeyRefusal } = await import('../../src/services/providers/qwen/qwenAccounts.ts')
  const { refreshQwenCatalogue, __resetQwenCatalogueForTest, qwenCatalogueRows, qwenCatalogueSourceWords, getCachedQwenCatalogue, probeQwenEndpoints } = await import('../../src/services/providers/qwen/qwenCatalogue.ts')
  const { buildQwenExtras } = await import('../../src/services/providers/qwen/qwenCallModel.ts')
  const { storeQwenApiKeyLogin } = await import('../../src/services/providers/qwen/qwenLogin.ts')
  const { QWEN_DISPLAY_PINS } = await import('../../src/services/providers/qwen/qwenPins.ts')
  const { usageForProvider } = await import('../../src/services/providers/providerUsage.ts')
  const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
  const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
  const { keyLaneListState, keyLanePins, keyLaneProviderRows, QWEN_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
  const pickerWords = (): string[] => keyLaneProviderRows().filter(row => row.group === QWEN_MODEL_GROUP).map(row => row.descriptionForModel ?? '')
  const { readStoredQwenApiKey, readStoredQwenKeyBase } = await import('../../src/services/providers/providerSecrets.ts')
  const { liveModelsReference, knownModelsReference } = await import('../../src/services/resources/adapters/models.ts')
  const { loginFamilyRows, KEY_PAGES, keyPageLine } = await import('../../src/components/loginFamilyRows.ts')
  const { providerAuthLogin, normalizeTerminalAuthFamily } = await import('../../src/cli/handlers/providerAuth.ts')
  const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
  const { bareFamilyWordOf } = await import('../../src/utils/model/bareFamilyWords.ts')
  const { getContextWindowForModel, getModelMaxOutputTokens, modelSupportsThinking } = await import('../../src/utils/model/capabilities.ts')
  const { getModelCosts, modelPricingBasis } = await import('../../src/utils/modelCost.ts')
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  const { effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { resolveQwenAccount } = await import('../../src/services/providers/qwen/qwenAccounts.ts')
  const { deriveFamilySlotGroups } = await import('../../src/services/providers/accountSlots.ts')
  const { validateModel } = await import('../../src/utils/model/validateModel.ts')
  const stateFacts = (models: unknown): void => { mkdirSync(proofHome, { recursive: true }); writeFileSync(join(proofHome, 'settings.json'), JSON.stringify({ models })); resetSettingsCache() }
  const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
  function params(model = 'qwen3.8-max', effortValue: string | undefined = 'max', thinking = true, messages: Message[] = [createUserMessage({ content: 'hello fixture' })]): CompatCallModelParams {
    return { messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture system', 'Second system block']), thinkingConfig: thinking ? { type: 'enabled', budgetTokens: 4096 } : { type: 'disabled' }, signal: new AbortController().signal,
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
  const systemRows = (messages: any[]): number[] => messages.map((row, index) => [row.role, index] as const).filter(([role]) => role === 'system').map(([, index]) => index)

  section('the endpoint table')
  const documented = ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1', 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1', 'https://maas.qwencloudapi.com/compatible-mode/v1', 'https://coding-intl.dashscope.aliyuncs.com/v1', 'https://coding.dashscope.aliyuncs.com/v1', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1']
  check('the nine documented regional and plan bases are the probe order, international pay-as-you-go first and QwenCloud before the Coding Plan bases', JSON.stringify(QWEN_SHARED_ENDPOINTS.map(endpoint => endpoint.baseUrl)) === JSON.stringify(documented) && qwenProbeEndpoints({}).length === 9)
  check('the proof seam rewrites every endpoint onto the loopback origin by its id and leaves the real URLs untouched without it', qwenEndpointBase(QWEN_SHARED_ENDPOINTS[1]!) === `${seam}/beijing` && qwenEndpointBase(QWEN_SHARED_ENDPOINTS[1]!, {}) === documented[1])
  const workspaceEndpoints = qwenProbeEndpoints({ DASHSCOPE_WORKSPACE_ID: 'llm-fixture' })
  check('a workspace id leads the probe with the six workspace-dedicated domains, Virginia among them', workspaceEndpoints.length === 15 && workspaceEndpoints[1]?.baseUrl === 'https://llm-fixture.us-east-1.maas.aliyuncs.com/compatible-mode/v1' && workspaceEndpoints.slice(0, 6).every(endpoint => /^https:\/\/llm-fixture\.[a-z0-9-]+\.maas\.aliyuncs\.com\/compatible-mode\/v1$/.test(endpoint.baseUrl)))
  check('an invalid workspace id adds no domain', qwenProbeEndpoints({ DASHSCOPE_WORKSPACE_ID: '../evil' }).length === 9 && qwenProbeEndpoints({ DASHSCOPE_WORKSPACE_ID: 'llm fixture' }).length === 9)

  section('the wire')
  check('a key configures the Qwen backend but is not a claimed live turn', resolvePrimaryAgentBackend('qwen3.8-max')?.id === 'qwen-chat' && resolvePrimaryAgentBackend('qwen')?.readiness().state === 'configured' && resolveProviderUsability().qwen.usable)
  const first = await run()
  const body = captures[0]!.body
  check('the first turn probes the endpoints in order and binds the first that lists models — International (Singapore) — then dispatches there', listReads[0] === 'singapore' && captures[0]?.endpoint === 'singapore' && qwenBoundBase() === `${seam}/singapore` && captures[0]?.bearer === KEY_INTL && body.model === 'qwen3.8-max')
  check("qwen3.8-max at the session's max carries enable_thinking true, preserve_thinking true and Qwen's own top rung reasoning_effort xhigh — never a thinking_budget", body.enable_thinking === true && body.preserve_thinking === true && body.reasoning_effort === 'xhigh' && !('thinking_budget' in body))
  check('every request streams with the usage chunk, function tools and auto choice; the output override rides max_tokens', body.stream === true && body.stream_options?.include_usage === true && body.tools[0].function.name === 'FixtureEcho' && body.tool_choice === 'auto' && body.max_tokens === 512 && !('max_completion_tokens' in body))
  check('both system blocks ride in messages[0] alone', JSON.stringify(systemRows(body.messages)) === '[0]' && body.messages[0].content.includes('Fixture system') && body.messages[0].content.includes('Second system block'))
  check('reasoning_content deltas become one thinking block and the visible text keeps every byte', thinkingOf(first) === 'Weighing the fixture carefully.' && textOf(first) === 'QWEN-FIXTURE-SETTLED')
  const usage = first.at(-1)?.message.usage
  check('cached input and completion tokens settle once from the final usage chunk', usage?.input_tokens === 28 && usage.cache_read_input_tokens === 4 && usage.output_tokens === 103)
  check('a settled turn alone advances the readiness receipt', resolvePrimaryAgentBackend('qwen')?.readiness().state === 'ready')
  const off = await run(params('qwen3.8-max', 'max', false))
  check('thinking off sends enable_thinking false, keeps preserve_thinking, sends no effort word, and the reply carries no thinking block', captures.at(-1)?.body.enable_thinking === false && captures.at(-1)?.body.preserve_thinking === true && !('reasoning_effort' in captures.at(-1)!.body) && thinkingOf(off) === '' && textOf(off) === 'QWEN-FIXTURE-SETTLED')
  await run(params('qwen3.8-max', 'low'))
  const lowBody = captures.at(-1)!.body
  await run(params('qwen3.8-max', 'medium'))
  const mediumBody = captures.at(-1)!.body
  await run(params('qwen3.8-max', 'high'))
  const highBody = captures.at(-1)!.body
  check("the operator's dial rides in Qwen's vocabulary and never below it: low → low, medium → medium, high → xhigh (Qwen has no high rung)", lowBody.reasoning_effort === 'low' && mediumBody.reasoning_effort === 'medium' && highBody.reasoning_effort === 'xhigh')
  check('the picker offers the qwen3.8 rows their own three rungs and the other rows no dial', JSON.stringify(effortVocabularyFor('qwen3.8-max')) === JSON.stringify({ kind: 'provider', source: 'qwen', vocabulary: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh', thinkingGated: true }) && effortVocabularyFor('qwen3.7-plus').kind === 'none' && effortVocabularyFor('qwen3-coder-flash').kind === 'none')
  stateFacts({ 'qwen3.8-max': { thinkingBudget: 2048 } })
  await run(params('qwen3.8-max', 'max'))
  const budgeted = captures.at(-1)!.body
  check('a thinking budget the operator states in the model facts rides as thinking_budget and the effort word stays off that request', budgeted.thinking_budget === 2048 && !('reasoning_effort' in budgeted) && budgeted.enable_thinking === true)
  await run(params('qwen3.8-max', 'max', false))
  check('with thinking off a stated budget is not sent either', !('thinking_budget' in captures.at(-1)!.body) && captures.at(-1)?.body.enable_thinking === false)
  stateFacts({})
  await run(params('qwen3-coder-flash'))
  check('Coder Flash supports thinking (alibabacloud.com text-generation-model, read 2026-10-25)', captures.at(-1)!.body.enable_thinking === true && !('preserve_thinking' in captures.at(-1)!.body) && captures.at(-1)?.body.model === 'qwen3-coder-flash')
  await run(params('qwen-plus'))
  check('a live-listed hybrid row this build has no pin for takes enable_thinking alone', captures.at(-1)?.body.enable_thinking === true && !('preserve_thinking' in captures.at(-1)!.body))
  await run(params('qwen3-coder-plus'))
  check('a live-only id the pins do not know rides as listed, with only the stream knobs', captures.at(-1)?.body.model === 'qwen3-coder-plus' && !('enable_thinking' in captures.at(-1)!.body))
  check('the knob builder: a qwen3.8 row at low, a qwen3.7 row with no dial, Coder Flash with thinking enabled (Alibaba Cloud models, read 2026-10-25)', JSON.stringify(buildQwenExtras({ wireModel: 'qwen3.8-max', effortValue: 'low', thinkingEnabled: true, maxOutputTokensOverride: undefined })) === '{"stream_options":{"include_usage":true},"enable_thinking":true,"preserve_thinking":true,"reasoning_effort":"low"}' && JSON.stringify(buildQwenExtras({ wireModel: 'qwen3.7-plus', effortValue: 'low', thinkingEnabled: true, maxOutputTokensOverride: undefined })) === '{"stream_options":{"include_usage":true},"enable_thinking":true,"preserve_thinking":true}' && JSON.stringify(buildQwenExtras({ wireModel: 'qwen3-coder-flash', effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: 256 })) === '{"stream_options":{"include_usage":true},"enable_thinking":true,"max_tokens":256}')
  mode = 'tools'
  const tools = await run(params('qwen3.7-plus'))
  const calls = tools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use')
  check('fragmented tool arguments become one validated executable call under the provider id', calls.length === 1 && calls[0]?.type === 'tool_use' && calls[0].id === 'call_qwen_fixture_1' && JSON.stringify(calls[0].input) === '{"text":"hello"}')
  mode = 'text'
  await run(params('qwen3.7-plus', 'max', true, [...tools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_qwen_fixture_1', content: 'echo:hello' }] })]))
  const history = captures.at(-1)!.body.messages
  check('a qwen3.7 row takes the thinking switch alone: no reasoning_effort rides beside it', !('reasoning_effort' in captures.at(-1)!.body) && captures.at(-1)?.body.enable_thinking === true)
  check('a preserve_thinking row replays the assistant call with its reasoning_content and the tool result, with messages[0] still the only system row', history.some((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'call_qwen_fixture_1' && row.reasoning_content === 'Calling the fixture tool.') && history.some((row: any) => row.role === 'tool' && row.tool_call_id === 'call_qwen_fixture_1') && JSON.stringify(systemRows(history)) === '[0]')
  mode = 'tools'
  const coderTools = await run(params('qwen3-coder-flash'))
  mode = 'text'
  await run(params('qwen3-coder-flash', 'max', true, [...coderTools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_qwen_fixture_1', content: 'echo:hello' }] })]))
  check('a row without preserve_thinking replays no reasoning_content', captures.at(-1)!.body.messages.every((row: any) => !('reasoning_content' in row)))
  check('late tool declarations ride inside the tool result row, never as a second system row', readFileSync(new URL('../../src/services/providers/qwen/qwenCallModel.ts', import.meta.url), 'utf8').includes('toolDeclarationRow: toolDeclarationRowInResult'))

  section('the catalogue: live ids beside the pins')
  const rows = qwenCatalogueRows()
  check('the live list serves every text row the endpoint names, the pinned ones first, and sets the embedding, rerank, speech, video, realtime and third-party rows aside; the pins the list lacks (Qwen3.7 Max, Qwen3.6 Flash) still show from the pin, unlisted', rows.source.kind === 'live' && rows.source.count === TEXT_IDS.length && rows.rows.length === TEXT_IDS.length + 2 && rows.rows.filter(row => row.listedLive).every(row => TEXT_IDS.includes(row.id)) && rows.rows.filter(row => !row.listedLive).map(row => row.id).sort().join(',') === 'qwen3.6-flash,qwen3.7-max' && rows.rows[0]?.id === 'qwen3.8-max' && rows.source.otherLines === OTHER_IDS.length)
  check('pinned facts fill the pinned rows and the live-only rows show themselves', rows.rows.find(row => row.id === 'qwen3.8-max')?.contextWindow === 1_000_000 && rows.rows.find(row => row.id === 'qwen3-coder-plus')?.contextWindow === undefined && keyLanePins('qwen').find(pin => pin.id === 'qwen3-coder-plus')?.liveUnknown === true && keyLanePins('qwen').find(pin => pin.id === 'qwen3.8-max')?.liveUnknown !== true)
  check('the source words name the bound endpoint and the rows set aside', (qwenCatalogueSourceWords() ?? '').includes('live on International (Singapore)') && (qwenCatalogueSourceWords() ?? '').includes(`${OTHER_IDS.length} of other lines not listed`) && keyLaneListState('qwen').kind === 'live')
  check('the Qwen3.8 Max console facts stand and Coder Flash thinks (alibabacloud.com text-generation-model, read 2026-10-25)', getContextWindowForModel('qwen3.8-max') === 1_000_000 && getModelMaxOutputTokens('qwen3.8-max').upperLimit === 131_072 && modelPricingBasis('qwen3.8-max') === 'recorded' && getModelCosts('qwen3.8-max').inputTokens === 2 && getModelCosts('qwen3.8-max').outputTokens === 6 && getModelCosts('qwen3.8-max').promptCacheReadTokens === 0.25 && getModelCosts('qwen3.8-max').promptCacheWriteTokens === 2.5 && modelSupportsThinking('qwen3.8-max') && modelSupportsThinking('qwen3-coder-flash'))
  check('the live resource carries the listed Qwen rows with the unlisted pins and the known resource the dated pay-as-you-go pins under the family word', (await liveModelsReference({ engineModel: 'qwen3.8-max' })).providers.find(row => row.provider === 'qwen')?.models.length === TEXT_IDS.length + 2 && (await knownModelsReference()).providers.find(row => row.provider === 'qwen')?.models.map(row => row.id).join(',') === PAY_AS_YOU_GO_PINS.join(',') && (await knownModelsReference()).providers.find(row => row.provider === 'qwen')?.familyWord === 'qwen')
  check("the bare word 'qwen' is known and resolves to the live head row", bareFamilyWordOf('qwen')?.route === 'qwen' && bareFamilyWordOf('qwen')?.headRow()?.id === 'qwen3.8-max' && (await resolveEngineDispatch('qwen'))?.model === 'qwen3.8-max')
  modelList = liveRows([...TEXT_IDS.filter(id => id !== 'qwen3.8-max'), ...OTHER_IDS]); await refreshQwenCatalogue({ force: true })
  const lacking = qwenCatalogueRows()
  const lackingBefore = captures.length
  const lackingRun = await run(params('qwen'))
  check("a pay-as-you-go live list that lacks qwen3.8-max still shows it first from the pin (unlisted), 'qwen' resolves to it, and the turn rides the wire with the note that the list did not name it", lacking.source.kind === 'live' && lacking.rows[0]?.id === 'qwen3.8-max' && lacking.rows[0].listedLive === false && lacking.rows.filter(row => row.listedLive).length === TEXT_IDS.length - 1 && bareFamilyWordOf('qwen')?.headRow()?.id === 'qwen3.8-max' && (await validateModel('qwen3.8-max')).valid && captures.length === lackingBefore + 1 && captures.at(-1)?.body.model === 'qwen3.8-max' && textOf(lackingRun).endsWith('QWEN-FIXTURE-SETTLED') && textOf(lackingRun).includes("'qwen3.8-max' is a pinned Model Studio id the endpoint's list does not name — sent for Model Studio to decide."))
  modelList = fixtures; await refreshQwenCatalogue({ force: true })
  check('Agent exact dispatch keeps a pinned id and admits a live-only id', (await resolveEngineDispatch('qwen3.7-plus'))?.model === 'qwen3.7-plus' && (await resolveEngineDispatch('qwen3-coder-plus'))?.backend === 'qwen')
  const meter = usageForProvider('qwen')
  check('/usage says plainly that no endpoint states usage or balance to an API key, naming the console and the credential checked', meter.sourceKind === 'api-key' && meter.windows.length === 0 && meter.credits?.state === 'unreported' && (meter.absence ?? '').includes('no usage, balance or quota endpoint') && (meter.absence ?? '').includes('the key was the one credential checked') && (meter.absence ?? '').includes('International (Singapore)'))

  section('the sign-in: the region and plan probe')
  const row = loginFamilyRows({ engineLegs: true }).find(item => item.value === 'qwen')
  check('/logins carries the Qwen row beneath Fireworks, naming both consoles, with the Model Studio key page', row?.label.startsWith('Qwen — QwenCloud or Model Studio API key') === true && loginFamilyRows({ engineLegs: true }).findIndex(item => item.value === 'fireworks') === loginFamilyRows({ engineLegs: true }).findIndex(item => item.value === 'qwen') - 1 && KEY_PAGES.qwen === 'modelstudio.alibabacloud.com' && keyPageLine('qwen').includes('API key: modelstudio.alibabacloud.com'))
  delete process.env.DASHSCOPE_API_KEY
  forgetQwenBoundBases(); __resetQwenCatalogueForTest()
  listReads.length = 0
  const cn = await storeQwenApiKeyLogin(KEY_CN)
  check('a key only China (Beijing) accepts binds there: Singapore refused it first, the key and its endpoint are stored together', cn.ok && cn.stored && JSON.stringify(listReads) === '["singapore","beijing"]' && cn.receipt.includes('bound to China (Beijing)') && cn.receipt.includes(`${TEXT_IDS.length} text models listed`) && readStoredQwenApiKey() === KEY_CN && readStoredQwenKeyBase() === `${seam}/beijing`)
  const beforeStored = captures.length
  await run()
  check('the stored key dispatches on its bound endpoint, never on the first in the table', captures.length === beforeStored + 1 && captures.at(-1)?.endpoint === 'beijing' && captures.at(-1)?.bearer === KEY_CN)
  listReads.length = 0
  const nowhere = await storeQwenApiKeyLogin(KEY_NOWHERE)
  check('a key no endpoint accepts is refused with the words and the service\'s own, the six authenticating endpoints tried and the Coding Plan ones (whose list answers every caller) never asked, nothing stored', !nowhere.ok && !nowhere.stored && JSON.stringify(listReads) === '["singapore","beijing","hongkong","qwencloud","token-plan-intl","token-plan-cn"]' && nowhere.receipt.startsWith('No QwenCloud or Model Studio endpoint accepted this key — nothing stored; this key belongs to no QwenCloud or Model Studio region or plan Mercury knows — it was minted for none of: International (Singapore) · China (Beijing) · China (Hong Kong) · QwenCloud (pay-as-you-go) · Token Plan (Singapore) · Token Plan (Beijing) (a Coding Plan key begins sk-sp-; this one does not, so the Coding Plan endpoints were not asked)') && nowhere.receipt.includes('the service said: Incorrect API key provided. Keys are made at qwencloud.com (API Keys) or modelstudio.alibabacloud.com (API-KEY, in the region the key is for).') && nowhere.receipt.includes('DASHSCOPE_BASE_URL') && readStoredQwenApiKey() === KEY_CN && readStoredQwenKeyBase() === `${seam}/beijing`)
  console.log(nowhere.receipt)
  check('the refusal words are the one owner the probe and the catalogue share', (await probeQwenEndpoints({ key: KEY_NOWHERE })).kind === 'refused' && qwenUnboundKeyRefusal().startsWith('this key belongs to no QwenCloud or Model Studio region or plan Mercury knows'))
  listReads.length = 0
  let chatBefore = captures.length
  const codingNowhere = await storeQwenApiKeyLogin(KEY_CODING_NOWHERE)
  check('an sk-sp- key that QwenCloud Token Plan refuses by its list and both Coding Plan chat endpoints refuse by chat is refused with their words and both consoles named — the Coding Plan public model list never binds; nothing stored', !codingNowhere.ok && !codingNowhere.stored && JSON.stringify(listReads) === '["qwencloud-token-plan","coding-intl","coding-cn"]' && captures.length === chatBefore + 2 && captures.slice(chatBefore).every(row => CODING_ENDPOINTS.has(row.endpoint) && row.bearer === KEY_CODING_NOWHERE) && codingNowhere.receipt.includes('minted for none of: QwenCloud Token Plan · Coding Plan (international) · Coding Plan (China) (a key beginning sk-sp- is a Token Plan or Coding Plan key, read on the QwenCloud Token Plan and the Coding Plan endpoints)') && codingNowhere.receipt.includes('the service said: Invalid API-key provided / invalid access token or token expired') && codingNowhere.receipt.includes('Keys are made at qwencloud.com (API Keys) or modelstudio.alibabacloud.com (API-KEY, in the region the key is for).') && readStoredQwenApiKey() === KEY_CN)
  console.log(codingNowhere.receipt)
  listReads.length = 0
  chatBefore = captures.length
  const codingCn = await storeQwenApiKeyLogin(KEY_CODING_CN)
  const codingProbes = captures.slice(chatBefore)
  check('a Coding Plan key only China accepts binds to Coding Plan (China): QwenCloud Token Plan refused its list first, the international chat endpoint refused it next, and the binding call is one user turn at max_tokens 1, unstreamed, on the first listed text model', codingCn.ok && codingCn.stored && JSON.stringify(listReads) === '["qwencloud-token-plan","coding-intl","coding-cn"]' && codingProbes.length === 2 && codingProbes[0]?.endpoint === 'coding-intl' && codingProbes[1]?.endpoint === 'coding-cn' && codingProbes.every(row => row.bearer === KEY_CODING_CN && row.body.max_tokens === 1 && row.body.stream === false && row.body.model === 'qwen3.7-plus' && JSON.stringify(row.body.messages) === '[{"role":"user","content":"hi"}]') && codingCn.receipt.includes("bound to Coding Plan (China) (127.0.0.1:") && codingCn.receipt.includes("the plan's 6 documented models, Qwen3.8 Max first (the endpoint's own model list answers every caller and is not the plan's)") && readStoredQwenApiKey() === KEY_CODING_CN && readStoredQwenKeyBase() === `${seam}/coding-cn`)
  console.log(codingCn.receipt)
  __resetQwenCatalogueForTest(); await refreshQwenCatalogue({ force: true })
  const planRows = qwenCatalogueRows()
  check("on a Coding Plan endpoint the picker rows are the plan's documented models from the pins — Qwen3.8 Max first, then Qwen3.7 Max, Qwen3.7 Plus, Qwen3.8 Flash, Qwen3.6 Flash and the plan's own Auto row — never the stub list's ids", planRows.source.kind === 'plan' && planRows.rows.map(row => row.id).join(',') === CODING_PLAN_ROWS.join(',') && planRows.rows.map(row => row.displayName).join(' · ') === 'Qwen3.8 Max · Qwen3.7 Max · Qwen3.7 Plus · Qwen3.8 Flash · Qwen3.6 Flash · Auto (the plan picks the model)' && !planRows.rows.some(row => row.id === 'qwen3.6-plus' || row.id === 'qwen3.5-plus'))
  check('no plan row is a "new · no alias" row: every row is a pin with its name, and the list state reads as pins with the plan words', keyLanePins('qwen').every(pin => pin.liveUnknown !== true) && keyLaneListState('qwen').kind === 'pin' && (qwenCatalogueSourceWords() ?? '').includes("the Coding Plan's documented models on Coding Plan (China)") && (qwenCatalogueSourceWords() ?? '').includes("its model list answers every caller and is not the plan's list"))
  check("the family word 'qwen' resolves to Qwen3.8 Max on the plan, never to the stub list's first id", bareFamilyWordOf('qwen')?.headRow()?.id === 'qwen3.8-max' && (await resolveEngineDispatch('qwen'))?.model === 'qwen3.8-max' && (await validateModel('qwen')).valid && (await validateModel('qwen3.8-max')).valid && (await validateModel('qwen-auto')).valid)
  check("the plan's pinned facts: Qwen3.7 Max 1M / 128K / $2.5 in / $7.5 out / $0.25 cache read, text-only; Qwen3.6 Flash 1M / 64K / $0.25 / $1.5 / $0.025 with images; the Auto row states no window or price", getContextWindowForModel('qwen3.7-max') === 1_000_000 && getModelMaxOutputTokens('qwen3.7-max').upperLimit === 131_072 && getModelCosts('qwen3.7-max').inputTokens === 2.5 && getModelCosts('qwen3.7-max').outputTokens === 7.5 && getModelCosts('qwen3.7-max').promptCacheReadTokens === 0.25 && modelSupportsThinking('qwen3.7-max') && getContextWindowForModel('qwen3.6-flash') === 1_000_000 && getModelMaxOutputTokens('qwen3.6-flash').upperLimit === 65_536 && getModelCosts('qwen3.6-flash').inputTokens === 0.25 && getModelCosts('qwen3.6-flash').outputTokens === 1.5 && modelPricingBasis('qwen-auto') !== 'recorded')
  let planBefore = captures.length
  const planHead = await run(params('qwen'))
  check("'qwen' runs qwen3.8-max on the bound Coding Plan endpoint with the plan key", captures.length === planBefore + 1 && captures.at(-1)?.endpoint === 'coding-cn' && captures.at(-1)?.bearer === KEY_CODING_CN && captures.at(-1)?.body.model === 'qwen3.8-max' && textOf(planHead) === 'QWEN-FIXTURE-SETTLED')
  planBefore = captures.length
  const planAuto = await run(params('qwen-auto'))
  check("the plan's Auto row rides the wire as the plan's own 'auto' id", captures.length === planBefore + 1 && captures.at(-1)?.body.model === 'auto' && textOf(planAuto) === 'QWEN-FIXTURE-SETTLED')
  planBefore = captures.length
  const planTyped = await run(params('qwen3.5-plus'))
  check('an id the plan does not document is sent for the plan to decide, never refused against the stub list', captures.length === planBefore + 1 && captures.at(-1)?.body.model === 'qwen3.5-plus' && !planTyped.some(row => row.isApiErrorMessage))
  check('the account rows name the plan: the stored-key slot, the account label and /usage say Coding Plan (China)', resolveQwenAccount()?.label === 'Model Studio Coding Plan key (stored, auth-scoped)' && (deriveFamilySlotGroups().find(group => group.family.id === 'qwen')?.slots ?? []).some(slot => slot.kind === 'api-key' && slot.kindLabel === 'Coding Plan · API key' && slot.identity.includes('Coding Plan key (auth-scoped, Coding Plan (China))')) && usageForProvider('qwen').tier === 'Coding Plan' && usageForProvider('qwen').label === 'Coding Plan usage' && (usageForProvider('qwen').absence ?? '').includes('The key is bound to Coding Plan (China)') && (usageForProvider('qwen').absence ?? '').includes('counts model calls'))
  chatBefore = captures.length
  __resetQwenCatalogueForTest(); await refreshQwenCatalogue({ force: true }); await refreshQwenCatalogue({ force: true })
  check('once bound, the first catalogue read of a process authenticates the Coding Plan key once more and later reads spend no call', qwenCatalogueRows().source.kind === 'plan' && captures.length === chatBefore + 1 && captures.at(-1)?.endpoint === 'coding-cn' && captures.at(-1)?.body.max_tokens === 1)
  listReads.length = 0
  chatBefore = captures.length
  const qwencloudToken = await storeQwenApiKeyLogin(KEY_QWENCLOUD_TOKEN)
  check('a QwenCloud Token Plan key (sk-sp-) binds to QwenCloud Token Plan on the first GET /models alone without spending a chat call or asking the Coding Plan bases', qwencloudToken.ok && qwencloudToken.stored && JSON.stringify(listReads) === '["qwencloud-token-plan"]' && captures.length === chatBefore && qwencloudToken.receipt.includes('bound to QwenCloud Token Plan (127.0.0.1:') && qwencloudToken.receipt.includes('4 text models listed (5 non-text rows set aside)') && readStoredQwenApiKey() === KEY_QWENCLOUD_TOKEN && readStoredQwenKeyBase() === `${seam}/qwencloud-token-plan`)
  __resetQwenCatalogueForTest(); await refreshQwenCatalogue({ force: true })
  const qcRows = qwenCatalogueRows()
  check("on QwenCloud Token Plan the picker unites the live Qwen text rows with the plan's pins — Qwen3.8 Max first, then Qwen3.7 Max, Qwen3.7 Plus, Qwen3.8 Flash, Qwen3.6 Flash, Auto (the plan picks the model) and the live-listed qwen3.6-plus — while setting the gateway's non-Qwen and speech rows aside", qcRows.source.kind === 'live' && qcRows.source.count === 4 && qcRows.source.otherLines === 5 && qcRows.rows.map(row => row.id).join(',') === 'qwen3.8-max,qwen3.7-max,qwen3.7-plus,qwen3.8-flash,qwen3.6-flash,qwen-auto,qwen3.6-plus' && qcRows.rows.find(row => row.id === 'qwen-auto')?.displayName === 'Auto (the plan picks the model)')
  planBefore = captures.length
  const qcHead = await run(params('qwen'))
  const qcAuto = await run(params('qwen-auto'))
  check("on QwenCloud Token Plan 'qwen' runs qwen3.8-max without an unlisted-pin note, 'qwen-auto' rides as 'auto', and the account label, /accounts slot and /usage name QwenCloud Token Plan", captures.length === planBefore + 2 && captures.at(-2)?.endpoint === 'qwencloud-token-plan' && captures.at(-2)?.body.model === 'qwen3.8-max' && textOf(qcHead) === 'QWEN-FIXTURE-SETTLED' && captures.at(-1)?.endpoint === 'qwencloud-token-plan' && captures.at(-1)?.body.model === 'auto' && textOf(qcAuto) === 'QWEN-FIXTURE-SETTLED' && resolveQwenAccount()?.label === 'QwenCloud Token Plan key (stored, auth-scoped)' && (deriveFamilySlotGroups().find(group => group.family.id === 'qwen')?.slots ?? []).some(slot => slot.kind === 'api-key' && slot.kindLabel === 'QwenCloud Token Plan · API key' && slot.identity.includes('QwenCloud Token Plan key (auth-scoped, QwenCloud Token Plan)')) && usageForProvider('qwen').tier === 'QwenCloud Token Plan' && usageForProvider('qwen').label === 'QwenCloud Token Plan usage' && (usageForProvider('qwen').absence ?? '').includes('The key is bound to QwenCloud Token Plan') && (usageForProvider('qwen').absence ?? '').includes('qwencloud.com'))
  check('no key without the sk-sp- shape ever reached a Coding Plan chat endpoint', captures.filter(row => CODING_ENDPOINTS.has(row.endpoint)).every(row => typeof row.bearer === 'string' && row.bearer.startsWith('sk-sp-')))
  section('the words name the console the key belongs to, or both when none is known')
  forgetQwenBoundBases(); __resetQwenCatalogueForTest(); listReads.length = 0
  const empty = await storeQwenApiKeyLogin('   ')
  check('an empty paste asks for a QwenCloud or Model Studio key, naming both', !empty.ok && !empty.stored && empty.receipt === 'Paste a non-empty QwenCloud or Model Studio API key.', empty.receipt)
  const payg = await storeQwenApiKeyLogin(KEY_QWENCLOUD)
  check('a key QwenCloud pay-as-you-go accepts is stored as a QwenCloud key: the receipt names QwenCloud alone and the QwenCloud console', payg.ok && payg.stored && JSON.stringify(listReads) === '["singapore","beijing","hongkong","qwencloud"]' && payg.receipt.startsWith('QwenCloud API key stored (auth-scoped, mode 600) · bound to QwenCloud (pay-as-you-go) (127.0.0.1:') && payg.receipt.includes('Usage and balance are shown in the QwenCloud console (no endpoint states them to an API key).') && !payg.receipt.includes('Model Studio') && readStoredQwenKeyBase() === `${seam}/qwencloud`, payg.receipt)
  check('…and the account label and /usage name QwenCloud alone, the console page being qwencloud.com', resolveQwenAccount()?.label === 'QwenCloud API key (stored, auth-scoped)' && usageForProvider('qwen').credits?.reason === 'no balance endpoint answers an API key — qwencloud.com shows it' && (usageForProvider('qwen').absence ?? '').startsWith('QwenCloud and Model Studio document no usage, balance or quota endpoint an API key can read') && (usageForProvider('qwen').absence ?? '').includes('qwencloud.com shows the account') && (usageForProvider('qwen').absence ?? '').endsWith('The key is bound to QwenCloud (pay-as-you-go).'), `${resolveQwenAccount()?.label} · ${usageForProvider('qwen').credits?.reason} · ${usageForProvider('qwen').absence}`)
  __resetQwenCatalogueForTest(); await refreshQwenCatalogue({ force: true })
  const qcPicker = pickerWords()
  check('…and the /model picker says its Qwen rows run on the QwenCloud text models, never Model Studio', qcPicker.length > 0 && qcPicker.every(words => words.includes('on the QwenCloud text models') && !words.includes('Model Studio')), qcPicker.join(' | '))
  forgetQwenBoundBases(); __resetQwenCatalogueForTest(); listReads.length = 0
  const msBound = await storeQwenApiKeyLogin(KEY_CN)
  check('a key a Model Studio region accepts is stored as a Model Studio key: the receipt, the account label and /usage name Model Studio alone', msBound.ok && msBound.receipt.startsWith('Model Studio API key stored (auth-scoped, mode 600) · bound to China (Beijing) (') && msBound.receipt.includes('Usage and balance are shown in the Model Studio console (no endpoint states them to an API key).') && !msBound.receipt.includes('QwenCloud') && resolveQwenAccount()?.label === 'Model Studio API key (stored, auth-scoped)' && usageForProvider('qwen').credits?.reason === 'no balance endpoint answers an API key — modelstudio.console.alibabacloud.com (Usage & Billing) shows it' && (usageForProvider('qwen').absence ?? '').endsWith('The key is bound to China (Beijing).'), `${msBound.receipt} · ${resolveQwenAccount()?.label} · ${usageForProvider('qwen').credits?.reason}`)
  check('a key no console accepts is refused in both consoles\' names, never Model Studio alone', !nowhere.ok && nowhere.receipt.startsWith('No QwenCloud or Model Studio endpoint accepted this key') && !nowhere.receipt.includes('Model Studio refused') && !nowhere.receipt.includes('no Model Studio region'), nowhere.receipt)
  __resetQwenCatalogueForTest(); await refreshQwenCatalogue({ force: true })
  const msPicker = pickerWords()
  check('with a Model Studio key the /model picker says its Qwen rows run on the Model Studio text models, never QwenCloud', msPicker.length > 0 && msPicker.every(words => words.includes('on the Model Studio text models') && !words.includes('QwenCloud')), msPicker.join(' | '))
  process.env.DASHSCOPE_API_KEY = 'proof-key-qwen-unbound-fixture-not-a-real-key'
  __resetQwenCatalogueForTest(); await refreshQwenCatalogue({ force: true })
  const unboundPicker = pickerWords()
  check('with a key no endpoint accepted the /model picker names both consoles on every Qwen row', unboundPicker.length > 0 && unboundPicker.every(words => words.includes('on the QwenCloud or Model Studio text models')), unboundPicker.join(' | '))
  delete process.env.DASHSCOPE_API_KEY
  process.env.DASHSCOPE_BASE_URL = `${seam}/coding-intl`
  listReads.length = 0
  const coding = await storeQwenApiKeyLogin(KEY_CODING)
  check('DASHSCOPE_BASE_URL wins over the probe: only the named endpoint is read and the key is bound to it', coding.ok && coding.stored && JSON.stringify(listReads) === '["coding-intl"]' && coding.receipt.includes('bound to Coding Plan (international)') && coding.receipt.includes('from DASHSCOPE_BASE_URL') && readStoredQwenKeyBase() === `${seam}/coding-intl`)
  const overrideRefused = await storeQwenApiKeyLogin(KEY_CN)
  check('an override naming a Coding Plan endpoint that refuses the key stores nothing and names the host with the service\'s words — the public list there cannot vouch for a key', !overrideRefused.ok && !overrideRefused.stored && overrideRefused.receipt.includes('Model Studio Coding Plan (international) refused the credential (HTTP 401) — invalid access token or token expired') && overrideRefused.receipt.includes('not the endpoint this key was minted for') && readStoredQwenApiKey() === KEY_CODING)
  delete process.env.DASHSCOPE_BASE_URL
  process.env.DASHSCOPE_WORKSPACE_ID = 'llm-fixture'
  listReads.length = 0
  const workspace = await storeQwenApiKeyLogin(KEY_WORKSPACE)
  check('with a workspace id the dedicated domains are probed first and a Virginia key binds to the US (Virginia) workspace', workspace.ok && listReads[0] === 'workspace-singapore' && listReads[1] === 'workspace-virginia' && listReads.length === 2 && workspace.receipt.includes('bound to US (Virginia) workspace') && readStoredQwenKeyBase() === `${seam}/workspace-virginia`)
  delete process.env.DASHSCOPE_WORKSPACE_ID
  const terminalOut: string[] = []
  const terminal = await providerAuthLogin('qwen', {}, { key: KEY_INTL, writeOut: text => terminalOut.push(text), writeErr: text => terminalOut.push(text), exit: () => {} })
  check('mercury auth login qwen stores the key through the same probe and prints the bound endpoint', terminal.ok && terminal.code === 0 && terminalOut.join('').includes('bound to International (Singapore)') && readStoredQwenApiKey() === KEY_INTL && readStoredQwenKeyBase() === `${seam}/singapore` && normalizeTerminalAuthFamily('qwen') === 'qwen')
  const groqOut: string[] = []
  const groqTerminal = await providerAuthLogin('groq', {}, { key: 'proof-key-groq-terminal-fixture-not-a-real-key', writeOut: text => groqOut.push(text), writeErr: text => groqOut.push(text), exit: () => {} })
  check('the terminal door no longer prompts for a Groq, Cerebras or Fireworks key only to call the family unknown', !groqOut.join('').includes('Unknown provider family') && groqTerminal.receipt.includes('Groq') && ['groq', 'cerebras', 'fireworks'].every(family => normalizeTerminalAuthFamily(family) === family))

  section('refusals')
  __resetQwenCatalogueForTest()
  await refreshQwenCatalogue({ force: true })
  boundRefusesChat = true
  let before = captures.length
  const wrongRegion = await run()
  check('a 401 from the bound endpoint after sign-in names the region and the re-bind road, once, never a hop', captures.length === before + 1 && wrongRegion.some(row => row.isApiErrorMessage && row.error === 'authentication_failed') && words(wrongRegion).includes('Model Studio International (Singapore) refused the key') && words(wrongRegion).includes('region and plan it was minted in') && words(wrongRegion).includes('/logins qwen') && words(wrongRegion).includes('DASHSCOPE_BASE_URL'))
  console.log(words(wrongRegion))
  boundRefusesChat = false
  mode = 'billing'
  before = captures.length
  const billing = await run()
  check("DashScope's 400 Arrearage is a billing refusal that belongs to Qwen alone and names the console", captures.length === before + 1 && billing.some(row => row.isApiErrorMessage && row.error === 'billing_error') && words(billing).includes('modelstudio.console.alibabacloud.com') && laneBillingState('qwen').state === 'credit-exhausted' && laneBillingState('minimax').state === 'clear')
  mode = 'rate'
  before = captures.length
  const rate = await run()
  check('a 429 with retry-after names the wait and stays on the lane', captures.length === before + 1 && rate.some(row => row.isApiErrorMessage && row.error === 'rate_limit') && words(rate).includes('asks for a 1h wait'))
  mode = 'busy'
  before = captures.length
  await run()
  check('an overload retries Qwen once and a served turn clears the billing observation', captures.length === before + 2 && laneBillingState('qwen').state === 'clear')
  mode = 'misplaced'
  const misplaced = await run()
  check('a reasoning field on the choice rather than its delta is ignored', thinkingOf(misplaced) === '' && textOf(misplaced) === 'QWEN-FIXTURE-SETTLED' && !misplaced.some(row => row.isApiErrorMessage))
  mode = 'malformed'
  check('malformed tool JSON is never executable', !(await run()).some(row => row.message.content.some(block => block.type === 'tool_use')))
  mode = 'truncated'
  check('an unterminated stream does not count as success', (await run()).some(row => row.isApiErrorMessage))
  mode = 'text'
  before = captures.length
  const embedding = await run(params('qwen3.7-text-embedding'))
  check('an embedding id refuses before any request, naming the text road', captures.length === before && embedding.some(row => row.isApiErrorMessage) && words(embedding).includes('not on the text road'))
  const absent = await run(params('qwen3.9-fixture-absent'))
  check('an id the endpoint does not list refuses before inference', captures.length === before && absent.some(row => row.isApiErrorMessage) && words(absent).includes('qwen3.9-fixture-absent'))
  modelList = []; await refreshQwenCatalogue({ force: true })
  const emptyPins = qwenCatalogueRows()
  check('an empty live list falls to the dated pins labelled as pins, and a pinned id still rides under the note', emptyPins.source.kind === 'pins' && emptyPins.rows.map(row => row.id).join(',') === PAY_AS_YOU_GO_PINS.join(',') && emptyPins.rows.every(row => row.listedLive === false && row.observedAt === '2026-10-18') && keyLaneListState('qwen').kind === 'pin' && (qwenCatalogueSourceWords() ?? '').includes('pinned list — ') && !(await run()).some(row => row.isApiErrorMessage) && captures.length === before + 1 && captures.at(-1)?.body.model === 'qwen3.8-max')
  before = captures.length
  check('with the live list empty an unpinned id refuses before inference', (await run(params('qwen3-coder-plus'))).some(row => row.isApiErrorMessage) && captures.length === before)
  modelList = fixtures
  listStatus = 401; __resetQwenCatalogueForTest(); await refreshQwenCatalogue({ force: true })
  const refusedList = await run()
  check("a bound endpoint that now refuses the key reads as a refused credential and the turn refuses with the re-bind road", refusedList.some(row => row.isApiErrorMessage && row.error === 'authentication_failed') && words(refusedList).includes('refused the credential') && words(refusedList).includes('/logins qwen re-binds the key') && captures.length === before)
  listStatus = 200
  __resetQwenCatalogueForTest()
  process.env.MERCURY_QWEN_API_BASE = 'http://127.0.0.1:1'
  process.env.DASHSCOPE_API_KEY = 'proof-key-qwen-unreachable-fixture-not-a-real-key'
  forgetQwenBoundBases()
  await refreshQwenCatalogue({ force: true })
  const unreachable = qwenCatalogueRows()
  check('with no endpoint reachable an unbound key falls to the pins, labelled as pins, and the words count the endpoints that could not be read', unreachable.source.kind === 'pins' && unreachable.rows.every(row => row.listedLive === false) && (getCachedQwenCatalogue()?.lastError ?? '').includes('6 could not be read') && keyLaneListState('qwen').kind === 'pin')
  delete process.env.DASHSCOPE_API_KEY
  process.env.MERCURY_QWEN_API_BASE = seam
  __resetQwenCatalogueForTest(); forgetQwenBoundBases()
  const aborted = new AbortController(); aborted.abort()
  check('pre-aborted calls perform no inference', (await run({ ...params(), signal: aborted.signal })).length === 0 && captures.length === before)
  section('the Qwen account sign-in road is gone: the key road alone')
  const { QWEN_KEY_KINDS_LINE, QWEN_KEY_KINDS_SHORT } = await import('../../src/services/providers/qwen/qwenLogin.ts')
  const { qwenCatalogueIdentity } = await import('../../src/services/providers/qwen/qwenCatalogue.ts')
  const { qwenProviderAdapter } = await import('../../src/services/providers/qwen/qwenAdapter.ts')
  const face = readFileSync(new URL('../../src/components/BootLoginsScreen.tsx', import.meta.url), 'utf8')
  const card = readFileSync(new URL('../../src/services/providers/qwen/QwenConnect.tsx', import.meta.url), 'utf8')
  const family = readdirSync(new URL('../../src/services/providers/qwen/', import.meta.url))
  check("the /model pickers' refresh road reads the catalogue's own identity, which is the stored key's", readFileSync(new URL('../../src/commands/model/mercuryModel.tsx', import.meta.url), 'utf8').includes('identity: () => qwenCatalogueIdentity()') && qwenCatalogueIdentity()?.startsWith('stored:') === true && qwenCatalogueIdentity()?.endsWith(':bound') === true)
  check('the account sign-in road is gone: no OAuth module in the family folder, no device family or pick for Qwen in the face layer, the card is the key card alone, no plan-only pin, no plan alias, and the account is the key', !family.includes('qwenOauth.ts') && !/FaceDeviceFamily = [^;]*'qwen'/.test(face) && !/LoginsPickId = [^;]*'qwen'/.test(face) && !face.includes("openPick('qwen')") && !card.includes('device') && card.includes('<KeyCardTitle family="qwen"') && card.includes('{QWEN_KEY_KINDS_LINE}') && QWEN_DISPLAY_PINS.every(pin => !('planOnly' in pin)) && classifyModelRoute('coder-model').kind === 'unrecognised' && resolveQwenAccount()?.kind === 'api-key' && qwenProviderAdapter.describe().account.kind === 'api-key' && (deriveFamilySlotGroups().find(group => group.family.id === 'qwen')?.slots ?? []).every(slot => slot.kind === 'api-key'))
  check('the key card names QwenCloud, Model Studio and the Token Plan / Coding Plan keys (sk-sp-…), in the popup card and the face pane', QWEN_KEY_KINDS_LINE.includes('QwenCloud (qwencloud.com)') && QWEN_KEY_KINDS_LINE.includes('Model Studio API key') && QWEN_KEY_KINDS_LINE.includes('Coding Plan key (sk-sp-…)') && QWEN_KEY_KINDS_SHORT === 'Model Studio, QwenCloud or Coding Plan (sk-sp-…) key' && face.includes('${QWEN_KEY_KINDS_SHORT}') && loginFamilyRows({ engineLegs: true }).find(item => item.value === 'qwen')?.label.startsWith('Qwen — QwenCloud or Model Studio API key') === true)
  const deviceFlagOut: string[] = []
  const deviceFlag = await providerAuthLogin('qwen', { device: true }, { key: KEY_CN, writeOut: text => deviceFlagOut.push(text), writeErr: text => deviceFlagOut.push(text), exit: () => {} })
  check('mercury auth login qwen --device is an unknown input: the key road runs as for every key family, the key binds through the probe, no refusal line names the flag', deviceFlag.ok && deviceFlag.receipt.includes('bound to China (Beijing)') && !deviceFlagOut.join('').toLowerCase().includes('device') && readStoredQwenApiKey() === KEY_CN)
  check('no request ever reached an OAuth path on the fixture', oauthCalls.length === 0)
  __resetQwenCatalogueForTest(); forgetQwenBoundBases()
  const { proveExistingCompatKnobs } = await import('../providers/lib/fast-infer-control.ts')
  await proveExistingCompatKnobs()
  console.log(`QWEN WIRE GREEN (${count} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
