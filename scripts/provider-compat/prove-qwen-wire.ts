import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
const KEY_CODING = 'proof-key-qwen-coding-fixture-not-a-real-key'
const KEY_WORKSPACE = 'proof-key-qwen-virginia-workspace-fixture-not-a-real-key'
const KEY_NOWHERE = 'proof-key-qwen-nowhere-fixture-not-a-real-key'
const ACCEPTS: Record<string, string> = { [KEY_INTL]: 'singapore', [KEY_CN]: 'beijing', [KEY_CODING]: 'coding-intl', [KEY_WORKSPACE]: 'workspace-virginia' }
const QWEN_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56'
const oauthCalls: Array<{ path: string; form: Record<string, string>; requestId: string | null }> = []
let deviceChallenge = ''
let pollScript: string[] = []
let tokenSerial = 0
let refreshMode = 'ok'
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
  if (endpoint === 'plan') {
    const planBearer = bearer === `proof-token-qwen-access-${tokenSerial}-not-real`
    if (path === '/models') { listReads.push('plan'); return planBearer ? Response.json({ object: 'list', data: liveRows(['coder-model', 'qwen3-coder-plus']) }) : refuse(401, 'invalid_api_key', 'Incorrect API key provided. ') }
    if (path === '/chat/completions' && req.method === 'POST') {
      const raw = await req.text()
      assert.ok(!raw.includes('proof-token-qwen'))
      const body = JSON.parse(raw) as Record<string, any>
      captures.push({ endpoint: 'plan', body, bearer })
      if (!planBearer) return refuse(401, 'invalid_api_key', 'Incorrect API key provided. ')
      return new Response(`data: ${JSON.stringify({ id: 'chatcmpl-plan', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'PLAN-SETTLED' }, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ id: 'chatcmpl-plan', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
  }
  if (path === '/models') {
    listReads.push(endpoint!)
    if (!accepted || listStatus === 401) return refuse(401, 'invalid_api_key', 'Incorrect API key provided. ')
    if (listStatus !== 200) return refuse(listStatus, 'server_error', 'unavailable')
    return Response.json({ object: 'list', data: modelList })
  }
  if (url.pathname === '/api/v1/oauth2/device/code' || url.pathname === '/api/v1/oauth2/token') {
    const form = Object.fromEntries(new URLSearchParams(await req.text()))
    oauthCalls.push({ path: url.pathname, form, requestId: req.headers.get('x-request-id') })
    if (url.pathname === '/api/v1/oauth2/device/code') {
      if (form.client_id !== QWEN_CLIENT_ID || form.scope !== 'openid profile email model.completion' || form.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(form.code_challenge ?? '')) return Response.json({ error: 'invalid_request', error_description: 'bad device request' }, { status: 400 })
      deviceChallenge = form.code_challenge!
      return Response.json({ device_code: 'proof-device-code-qwen-not-real', user_code: 'ABCD-1234', verification_uri: `${seam}/device`, verification_uri_complete: `${seam}/device?user_code=ABCD-1234`, expires_in: 300 })
    }
    if (form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      const verifierMatches = typeof form.code_verifier === 'string' && createHash('sha256').update(form.code_verifier).digest('base64url') === deviceChallenge
      if (form.client_id !== QWEN_CLIENT_ID || form.device_code !== 'proof-device-code-qwen-not-real' || !verifierMatches) return Response.json({ error: 'invalid_grant', error_description: 'bad poll' }, { status: 400 })
      const step = pollScript.shift() ?? 'authorized'
      if (step === 'pending') return Response.json({ error: 'authorization_pending', error_description: 'waiting' }, { status: 400 })
      if (step === 'slow') return Response.json({ error: 'slow_down', error_description: 'slower' }, { status: 429 })
      if (step === 'denied') return Response.json({ error: 'access_denied', error_description: 'declined in the browser' }, { status: 400 })
      tokenSerial++
      return Response.json({ access_token: `proof-token-qwen-access-${tokenSerial}-not-real`, refresh_token: `proof-token-qwen-refresh-${tokenSerial}-not-real`, token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email model.completion', resource_url: 'portal.qwen.ai' })
    }
    if (form.grant_type === 'refresh_token') {
      if (refreshMode === 'revoked') return Response.json({ error: 'invalid_grant', error_description: 'the refresh token was revoked' }, { status: 400 })
      if (form.client_id !== QWEN_CLIENT_ID || form.refresh_token !== `proof-token-qwen-refresh-${tokenSerial}-not-real`) return Response.json({ error: 'invalid_grant', error_description: 'unknown refresh token' }, { status: 400 })
      tokenSerial++
      return Response.json({ access_token: `proof-token-qwen-access-${tokenSerial}-not-real`, refresh_token: `proof-token-qwen-refresh-${tokenSerial}-not-real`, token_type: 'Bearer', expires_in: 3600, resource_url: 'portal.qwen.ai' })
    }
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
  }
  if (path !== '/chat/completions' || req.method !== 'POST') return new Response('not found', { status: 404 })
  const raw = await req.text()
  for (const key of Object.keys(ACCEPTS)) assert.ok(!raw.includes(key))
  const body = JSON.parse(raw) as Record<string, any>
  captures.push({ endpoint: endpoint!, body, bearer })
  if (!accepted || boundRefusesChat || mode === 'auth') return refuse(401, 'invalid_api_key', 'Incorrect API key provided. ')
  for (const forbidden of ['max_completion_tokens', 'reasoning', 'thinking', 'temperature', 'top_p']) if (forbidden in body) return refuse(400, 'invalid_parameter', `unsupported parameter ${forbidden}`)
  if ('reasoning_effort' in body && 'thinking_budget' in body) return refuse(400, 'invalid_parameter', 'reasoning_effort and thinking_budget cannot be set at the same time')
  if ('reasoning_effort' in body && (!/^qwen3\.8-(?:max|flash|omni-flash|2\.4t-a95b|27b)/.test(body.model) || !['low', 'medium', 'xhigh'].includes(body.reasoning_effort))) return refuse(400, 'invalid_parameter', `reasoning_effort ${body.reasoning_effort} on ${body.model}`)
  if ('thinking_budget' in body && !(Number.isInteger(body.thinking_budget) && body.thinking_budget > 0)) return refuse(400, 'invalid_parameter', 'thinking_budget')
  if (body.messages.some((row: any, index: number) => row.role === 'system' && index !== 0)) return refuse(400, 'invalid_parameter', 'only messages[0] takes the system role')
  if (/^qwen3-coder/.test(body.model) && ('enable_thinking' in body || 'preserve_thinking' in body)) return refuse(400, 'invalid_parameter', 'thinking knobs on a non-thinking model')
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
process.env.MERCURY_QWEN_PORTAL_BASE = seam
process.env.MERCURY_GROQ_API_BASE = `${seam}/groq-fixture/openai/v1`
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
const section = (name: string): void => console.log(`\n── ${name}`)
try {
  const { classifyModelRoute } = await import('../../src/services/providers/routeLaw.ts')
  const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
  section('routing')
  check('the bare Model Studio ids, the family word and the plan alias route to Qwen before any request', ['qwen3.8-max', 'qwen3.7-plus', 'qwen3-coder-flash', 'qwen-plus', 'qwq-plus', 'qwen', 'coder-model', 'Qwen3.8-Max'].every(id => classifyModelRoute(parseUserSpecifiedModel(id)).route === 'qwen'))
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
  const { keyLaneListState, keyLanePins } = await import('../../src/utils/model/modelOptions.ts')
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
  const documented = ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1', 'https://coding-intl.dashscope.aliyuncs.com/v1', 'https://coding.dashscope.aliyuncs.com/v1', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1']
  check('the seven documented regional and plan bases are the probe order, international pay-as-you-go first', JSON.stringify(QWEN_SHARED_ENDPOINTS.map(endpoint => endpoint.baseUrl)) === JSON.stringify(documented) && qwenProbeEndpoints({}).length === 7)
  check('the proof seam rewrites every endpoint onto the loopback origin by its id and leaves the real URLs untouched without it', qwenEndpointBase(QWEN_SHARED_ENDPOINTS[1]!) === `${seam}/beijing` && qwenEndpointBase(QWEN_SHARED_ENDPOINTS[1]!, {}) === documented[1])
  const workspaceEndpoints = qwenProbeEndpoints({ DASHSCOPE_WORKSPACE_ID: 'llm-fixture' })
  check('a workspace id leads the probe with the six workspace-dedicated domains, Virginia among them', workspaceEndpoints.length === 13 && workspaceEndpoints[1]?.baseUrl === 'https://llm-fixture.us-east-1.maas.aliyuncs.com/compatible-mode/v1' && workspaceEndpoints.slice(0, 6).every(endpoint => /^https:\/\/llm-fixture\.[a-z0-9-]+\.maas\.aliyuncs\.com\/compatible-mode\/v1$/.test(endpoint.baseUrl)))
  check('an invalid workspace id adds no domain', qwenProbeEndpoints({ DASHSCOPE_WORKSPACE_ID: '../evil' }).length === 7 && qwenProbeEndpoints({ DASHSCOPE_WORKSPACE_ID: 'llm fixture' }).length === 7)

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
  check('a non-thinking row sends neither enable_thinking nor preserve_thinking', !('enable_thinking' in captures.at(-1)!.body) && !('preserve_thinking' in captures.at(-1)!.body) && captures.at(-1)?.body.model === 'qwen3-coder-flash')
  await run(params('qwen-plus'))
  check('a live-listed hybrid row this build has no pin for takes enable_thinking alone', captures.at(-1)?.body.enable_thinking === true && !('preserve_thinking' in captures.at(-1)!.body))
  await run(params('qwen3-coder-plus'))
  check('a live-only id the pins do not know rides as listed, with only the stream knobs', captures.at(-1)?.body.model === 'qwen3-coder-plus' && !('enable_thinking' in captures.at(-1)!.body))
  check('the knob builder: a qwen3.8 row at low, a qwen3.7 row with no dial, a coder row with nothing but the stream knobs', JSON.stringify(buildQwenExtras({ wireModel: 'qwen3.8-max', effortValue: 'low', thinkingEnabled: true, maxOutputTokensOverride: undefined })) === '{"stream_options":{"include_usage":true},"enable_thinking":true,"preserve_thinking":true,"reasoning_effort":"low"}' && JSON.stringify(buildQwenExtras({ wireModel: 'qwen3.7-plus', effortValue: 'low', thinkingEnabled: true, maxOutputTokensOverride: undefined })) === '{"stream_options":{"include_usage":true},"enable_thinking":true,"preserve_thinking":true}' && JSON.stringify(buildQwenExtras({ wireModel: 'qwen3-coder-flash', effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: 256 })) === '{"stream_options":{"include_usage":true},"max_tokens":256}')
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
  check('the live list serves every text row the endpoint names, the pinned ones first, and sets the embedding, rerank, speech, video, realtime and third-party rows aside', rows.source.kind === 'live' && rows.rows.length === TEXT_IDS.length && rows.rows.map(row => row.id).every(id => TEXT_IDS.includes(id)) && rows.rows[0]?.id === 'qwen3.8-max' && rows.source.otherLines === OTHER_IDS.length)
  check('pinned facts fill the pinned rows and the live-only rows show themselves', rows.rows.find(row => row.id === 'qwen3.8-max')?.contextWindow === 1_000_000 && rows.rows.find(row => row.id === 'qwen3-coder-plus')?.contextWindow === undefined && keyLanePins('qwen').find(pin => pin.id === 'qwen3-coder-plus')?.liveUnknown === true && keyLanePins('qwen').find(pin => pin.id === 'qwen3.8-max')?.liveUnknown !== true)
  check('the source words name the bound endpoint and the rows set aside', (qwenCatalogueSourceWords() ?? '').includes('live on International (Singapore)') && (qwenCatalogueSourceWords() ?? '').includes(`${OTHER_IDS.length} of other lines not listed`) && keyLaneListState('qwen').kind === 'live')
  check('the pins carry the console facts read 2026-10-18: Qwen3.8 Max 1M window, 128K output, $2 in / $6 out / $0.25 cache read', getContextWindowForModel('qwen3.8-max') === 1_000_000 && getModelMaxOutputTokens('qwen3.8-max').upperLimit === 131_072 && modelPricingBasis('qwen3.8-max') === 'recorded' && getModelCosts('qwen3.8-max').inputTokens === 2 && getModelCosts('qwen3.8-max').outputTokens === 6 && getModelCosts('qwen3.8-max').promptCacheReadTokens === 0.25 && getModelCosts('qwen3.8-max').promptCacheWriteTokens === 2.5 && modelSupportsThinking('qwen3.8-max') && !modelSupportsThinking('qwen3-coder-flash'))
  check('the live resource carries the listed Qwen rows and the known resource the dated pins under the family word', (await liveModelsReference({ engineModel: 'qwen3.8-max' })).providers.find(row => row.provider === 'qwen')?.models.length === TEXT_IDS.length && (await knownModelsReference()).providers.find(row => row.provider === 'qwen')?.models.length === QWEN_DISPLAY_PINS.filter(pin => !pin.planOnly).length && (await knownModelsReference()).providers.find(row => row.provider === 'qwen')?.familyWord === 'qwen')
  check("the bare word 'qwen' is known and resolves to the live head row", bareFamilyWordOf('qwen')?.route === 'qwen' && bareFamilyWordOf('qwen')?.headRow()?.id === 'qwen3.8-max' && (await resolveEngineDispatch('qwen'))?.model === 'qwen3.8-max')
  check('Agent exact dispatch keeps a pinned id and admits a live-only id', (await resolveEngineDispatch('qwen3.7-plus'))?.model === 'qwen3.7-plus' && (await resolveEngineDispatch('qwen3-coder-plus'))?.backend === 'qwen')
  const meter = usageForProvider('qwen')
  check('/usage says plainly that no endpoint states usage or balance to an API key, naming the console and the credential checked', meter.sourceKind === 'api-key' && meter.windows.length === 0 && meter.credits?.state === 'unreported' && (meter.absence ?? '').includes('no usage, balance or quota endpoint') && (meter.absence ?? '').includes('the key was the one credential checked') && (meter.absence ?? '').includes('International (Singapore)'))

  section('the sign-in: the region and plan probe')
  const row = loginFamilyRows({ engineLegs: true }).find(item => item.value === 'qwen')
  check('/logins carries the Qwen row beneath Fireworks with the Model Studio key page', row?.label.startsWith('Qwen — Model Studio API key') === true && loginFamilyRows({ engineLegs: true }).findIndex(item => item.value === 'fireworks') === loginFamilyRows({ engineLegs: true }).findIndex(item => item.value === 'qwen') - 1 && KEY_PAGES.qwen === 'modelstudio.alibabacloud.com' && keyPageLine('qwen').includes('API key: modelstudio.alibabacloud.com'))
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
  check('a key no endpoint accepts is refused with the words, every endpoint tried, nothing stored', !nowhere.ok && !nowhere.stored && listReads.length === 7 && nowhere.receipt.includes('this key belongs to no Model Studio region or plan Mercury knows — it was minted for none of: International (Singapore) · China (Beijing) · China (Hong Kong) · Coding Plan (international) · Coding Plan (China) · Token Plan (Singapore) · Token Plan (Beijing)') && nowhere.receipt.includes('DASHSCOPE_BASE_URL') && readStoredQwenApiKey() === KEY_CN && readStoredQwenKeyBase() === `${seam}/beijing`)
  console.log(nowhere.receipt)
  check('the refusal words are the one owner the probe and the catalogue share', (await probeQwenEndpoints({ key: KEY_NOWHERE })).kind === 'refused' && qwenUnboundKeyRefusal().startsWith('this key belongs to no Model Studio region or plan Mercury knows'))
  process.env.DASHSCOPE_BASE_URL = `${seam}/coding-intl`
  listReads.length = 0
  const coding = await storeQwenApiKeyLogin(KEY_CODING)
  check('DASHSCOPE_BASE_URL wins over the probe: only the named endpoint is read and the key is bound to it', coding.ok && coding.stored && JSON.stringify(listReads) === '["coding-intl"]' && coding.receipt.includes('bound to Coding Plan (international)') && coding.receipt.includes('from DASHSCOPE_BASE_URL') && readStoredQwenKeyBase() === `${seam}/coding-intl`)
  const overrideRefused = await storeQwenApiKeyLogin(KEY_CN)
  check('an override naming an endpoint that refuses the key stores nothing and names the host', !overrideRefused.ok && !overrideRefused.stored && overrideRefused.receipt.includes('Coding Plan (international) refused the credential (HTTP 401)') && overrideRefused.receipt.includes('not the endpoint this key was minted for') && readStoredQwenApiKey() === KEY_CODING)
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
  check('an empty live list falls to the dated pins labelled as pins, and a pinned id still rides under the note', emptyPins.source.kind === 'pins' && emptyPins.rows.length === QWEN_DISPLAY_PINS.filter(pin => !pin.planOnly).length && emptyPins.rows.every(row => row.listedLive === false && row.observedAt === '2026-10-18') && keyLaneListState('qwen').kind === 'pin' && (qwenCatalogueSourceWords() ?? '').includes('pinned list (observed 2026-10-18)') && !(await run()).some(row => row.isApiErrorMessage) && captures.length === before + 1 && captures.at(-1)?.body.model === 'qwen3.8-max')
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
  check('with no endpoint reachable an unbound key falls to the pins, labelled as pins, and the words count the endpoints that could not be read', unreachable.source.kind === 'pins' && unreachable.rows.every(row => row.listedLive === false) && (getCachedQwenCatalogue()?.lastError ?? '').includes('7 could not be read') && keyLaneListState('qwen').kind === 'pin')
  delete process.env.DASHSCOPE_API_KEY
  process.env.MERCURY_QWEN_API_BASE = seam
  __resetQwenCatalogueForTest(); forgetQwenBoundBases()
  const aborted = new AbortController(); aborted.abort()
  check('pre-aborted calls perform no inference', (await run({ ...params(), signal: aborted.signal })).length === 0 && captures.length === before)
  section('the Qwen account sign-in: the device code, the token, the refresh, the revocation')
  const { runQwenDeviceLogin, QWEN_CONNECT_ROWS } = await import('../../src/services/providers/qwen/qwenLogin.ts')
  const { qwenStoredTokens, qwenAuthPathForDisplay, writeQwenTokens, qwenSigninRefusal, tokensFromQwenBody, clearStoredQwenSignin, QWEN_OAUTH_CLIENT_ID } = await import('../../src/services/providers/qwen/qwenOauth.ts')
  const { resolveQwenAccount, resolveQwenCredential } = await import('../../src/services/providers/qwen/qwenAccounts.ts')
  const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/services/providers/accountSlots.ts')
  check('the sign-in card offers the device road first and the key second, and the face layer carries the pick', QWEN_CONNECT_ROWS[0]?.value === 'device' && QWEN_CONNECT_ROWS[1]?.value === 'key' && QWEN_OAUTH_CLIENT_ID === QWEN_CLIENT_ID)
  check('a token body with a Qwen resource host is trusted and a foreign host is dropped', tokensFromQwenBody({ access_token: 'a', refresh_token: 'r', expires_in: 60, resource_url: 'portal.qwen.ai' }, { env: {} }).resourceUrl === 'https://portal.qwen.ai' && tokensFromQwenBody({ access_token: 'a', refresh_token: 'r', expires_in: 60, resource_url: 'https://evil.example/v1' }, { env: {} }).resourceUrl === undefined)
  pollScript = ['pending', 'slow', 'authorized']
  const events: string[] = []
  __resetQwenCatalogueForTest(); forgetQwenBoundBases()
  const signin = await runQwenDeviceLogin({ sleep: async () => {}, onEvent: event => events.push(event.phase === 'waiting' ? `waiting:${event.polls}:${event.start.userCode}` : event.phase) })
  const device = oauthCalls.find(call => call.path === '/api/v1/oauth2/device/code')
  const polls = oauthCalls.filter(call => call.path === '/api/v1/oauth2/token' && call.form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code')
  check('the device request carries the public client id, the scope, an S256 challenge and a request id; the polls carry the device code and the verifier that hashes to it', device?.form.client_id === QWEN_CLIENT_ID && device.form.scope === 'openid profile email model.completion' && device.form.code_challenge_method === 'S256' && device.requestId !== null && polls.length === 3 && polls.every(call => call.form.device_code === 'proof-device-code-qwen-not-real' && createHash('sha256').update(call.form.code_verifier!).digest('base64url') === deviceChallenge))
  check('pending and slow_down keep polling until the approval lands, and the events show the code', signin.ok && events[0] === 'starting' && events[1] === 'waiting:0:ABCD-1234' && events.includes('finishing') && signin.receipt.includes('Qwen account sign-in stored (auth-scoped, mode 600)') && signin.receipt.includes('2 text models listed on the plan endpoint') && signin.receipt.includes("the Qwen Coder plan's own terms"))
  console.log(signin.receipt)
  const stored = qwenStoredTokens()
  check('the tokens rest in the auth-scoped file at mode 600 with the resource host, and the sign-in is the account now', stored?.accessToken === 'proof-token-qwen-access-1-not-real' && stored.refreshToken === 'proof-token-qwen-refresh-1-not-real' && stored.resourceUrl === 'https://portal.qwen.ai' && (statSync(qwenAuthPathForDisplay()).mode & 0o777) === 0o600 && resolveQwenAccount()?.kind === 'signin' && readStoredQwenApiKey() === KEY_INTL)
  const qwenSlots = deriveFamilySlotGroups().find(group => group.family.id === 'qwen')?.slots ?? []
  check('/accounts shows the sign-in slot active beside the stored key, which steps aside', qwenSlots.some(slot => slot.id === 'qwen:signin' && slot.active && slot.signedIn && slot.kind === 'oauth') && qwenSlots.some(slot => slot.kind === 'api-key' && !slot.active && slot.stateNote === 'Qwen account sign-in selected'))
  before = captures.length
  const plan = await run(params('qwen'))
  check("the family word under the sign-in runs the plan's head row on the plan endpoint with the bearer token, never a Model Studio endpoint", captures.length === before + 1 && captures.at(-1)?.endpoint === 'plan' && captures.at(-1)?.bearer === 'proof-token-qwen-access-1-not-real' && captures.at(-1)?.body.model === 'coder-model' && textOf(plan) === 'PLAN-SETTLED' && !('enable_thinking' in captures.at(-1)!.body))
  check('the plan catalogue is live and the picker lists its rows under the sign-in', qwenCatalogueRows().source.kind === 'live' && qwenCatalogueRows().rows.map(row => row.id).join(',') === 'coder-model,qwen3-coder-plus' && (qwenCatalogueSourceWords() ?? '').includes('live on the Qwen account plan') && usageForProvider('qwen').sourceKind === 'oauth')
  writeQwenTokens({ ...stored!, expiresAtMs: Date.now() - 1 })
  before = captures.length
  await run(params('coder-model'))
  const refreshCalls = oauthCalls.filter(call => call.form.grant_type === 'refresh_token')
  check('an expired token is refreshed before the turn with the refresh grant and the client id, the fresh token rides the wire and rests in the file', refreshCalls.length === 1 && refreshCalls[0]?.form.client_id === QWEN_CLIENT_ID && refreshCalls[0].form.refresh_token === 'proof-token-qwen-refresh-1-not-real' && captures.length === before + 1 && captures.at(-1)?.bearer === 'proof-token-qwen-access-2-not-real' && qwenStoredTokens()?.accessToken === 'proof-token-qwen-access-2-not-real')
  refreshMode = 'revoked'
  writeQwenTokens({ ...qwenStoredTokens()!, expiresAtMs: Date.now() - 1 })
  before = captures.length
  const revoked = await run(params('coder-model'))
  check('a revoked refresh token refuses the turn before any request, names /logins qwen, and the account reads expired on every surface', captures.length === before && revoked.some(row => row.isApiErrorMessage) && words(revoked).includes('/logins qwen') && words(revoked).includes('expired') && qwenSigninRefusal()?.code === 'invalid_grant' && (await resolveQwenCredential()) === undefined && resolveQwenAccount()?.expired === true && resolveProviderUsability().qwen.usable === false && resolveProviderUsability().qwen.blockers.some(line => line.includes('/logins qwen')) && (deriveFamilySlotGroups().find(group => group.family.id === 'qwen')?.slots.find(slot => slot.id === 'qwen:signin')?.signedIn === false))
  console.log(words(revoked))
  const removal = deriveFamilySlotGroups().find(group => group.family.id === 'qwen')?.slots.find(slot => slot.id === 'qwen:signin')
  check('/accounts removes the sign-in and the stored key becomes the account again', removal !== undefined && executeSlotRemoval(removal).mutated && qwenStoredTokens() === undefined && resolveQwenAccount()?.kind === 'api-key')
  refreshMode = 'ok'; pollScript = ['authorized']
  const terminalDevice: string[] = []
  const deviceLogin = await providerAuthLogin('qwen', { device: true }, { writeOut: text => terminalDevice.push(text), writeErr: text => terminalDevice.push(text), exit: () => {} })
  check('mercury auth login qwen --device prints the URL and the code, and stores the sign-in', deviceLogin.ok && terminalDevice.join('').includes('Visit') && terminalDevice.join('').includes('ABCD-1234') && qwenStoredTokens()?.accessToken === 'proof-token-qwen-access-3-not-real')
  pollScript = ['denied']
  const declined = await runQwenDeviceLogin({ sleep: async () => {} })
  check('a sign-in declined in the browser stores nothing new and offers the key leg', !declined.ok && declined.receipt.includes('declined in the browser') && declined.receipt.includes('/logins qwen') && qwenStoredTokens()?.accessToken === 'proof-token-qwen-access-3-not-real')
  clearStoredQwenSignin(); __resetQwenCatalogueForTest(); forgetQwenBoundBases()
  const { proveExistingCompatKnobs } = await import('../providers/lib/fast-infer-control.ts')
  await proveExistingCompatKnobs()
  console.log(`QWEN WIRE GREEN (${count} checks; loopback fixture only)`)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
