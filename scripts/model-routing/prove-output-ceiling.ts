#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const key of Object.keys(process.env)) {
  if (
    /^(ANTHROPIC_(AUTH_TOKEN|BASE_URL|API_KEY)|MERCURY_(MODEL|SMALL_FAST_MODEL|OAUTH_TOKEN|MAX_OUTPUT_TOKENS|HOME|EFFORT_LEVEL|EFFORT|THINKING_BUDGET|CONFIG_DIR|AUTH_SCOPE_DIR|LOCAL_PROBE_TARGETS|DISABLE_1M_CONTEXT|WIRE_DUMP))$/.test(key) ||
    /^(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|GOOGLE|OPENROUTER|HF)_/.test(key) ||
    /^MERCURY_(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|OPENROUTER|HUGGINGFACE|COMPAT|LOCAL)_/.test(key)
  ) {
    delete process.env[key]
  }
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-output-ceiling-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'ollama=http://fixture.invalid:11434'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'
process.env.MERCURY_OPENROUTER_AUTH_BASE = 'https://fixture.invalid/auth'
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.OPENROUTER_API_KEY = 'sk-or-v1-OUTPUTCEILINGPROOF0000000'
process.env.GEMINI_API_KEY = 'AIza-OUTPUT-CEILING-PROOF-000'
process.env.OPENAI_API_KEY = 'prover-key'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''
const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — prove-output-ceiling exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: 0 })
Object.assign(process.env, fixture.env)

const configModule = (await import('../../src/utils/config.ts')) as unknown as { enableConfigs?: () => void }
configModule.enableConfigs?.()
const caps = await import('../../src/utils/model/capabilities.ts')
const openrouter = await import('../../src/services/providers/openrouter/openrouterCatalogue.ts')
const gemini = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const localDiscovery = await import('../../src/services/providers/local/localDiscovery.ts')
const localCatalogue = await import('../../src/services/providers/local/localCatalogue.ts')
const gptPins = await import('../../src/services/providers/openai/gptPins.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const streamCore = await import('../../src/services/providers/anthropic/streamCore.ts')
const { queryModelWithStreaming, getMaxOutputTokensForModel, adjustParamsForNonStreaming, MAX_NON_STREAMING_TOKENS } = streamCore
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const context = await import('../../src/utils/context.ts')

const CEILING = 128_000
const TODAY_DEFAULT = 32_000
const TODAY_UPPER = 64_000

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const OPENROUTER_PAGE = {
  data: [
    { id: 'wide/fixture-two-hundred', name: 'Fixture Two Hundred', context_length: 1_000_000, supported_parameters: ['tools'], top_provider: { context_length: 1_000_000, max_completion_tokens: 200_000 } },
    { id: 'wide/fixture-exact', name: 'Fixture Exact', context_length: 400_000, supported_parameters: ['tools'], top_provider: { context_length: 400_000, max_completion_tokens: 128_000 } },
    { id: 'wide/fixture-ninety-six', name: 'Fixture Ninety Six', context_length: 256_000, supported_parameters: ['tools'], top_provider: { context_length: 256_000, max_completion_tokens: 96_000 } },
    { id: 'wide/fixture-unstated', name: 'Fixture Unstated', context_length: 200_000, supported_parameters: ['tools'] },
    { id: 'anthropic/claude-opus-5', name: 'Anthropic: Claude Opus 5 (via the carrier)', context_length: 200_000, supported_parameters: ['tools'] },
  ],
  total_count: 5,
  links: { next: null },
}
const openrouterFetch: typeof fetch = (async () => jsonResponse(OPENROUTER_PAGE)) as unknown as typeof fetch
const GEMINI_PAGE = {
  models: [
    { name: 'models/gemini-fixture-wide', displayName: 'Gemini Fixture Wide', inputTokenLimit: 1_048_576, outputTokenLimit: 131_072, supportedGenerationMethods: ['generateContent'], thinking: true },
    { name: 'models/gemini-fixture-ninety-six', displayName: 'Gemini Fixture Ninety Six', inputTokenLimit: 1_048_576, outputTokenLimit: 96_000, supportedGenerationMethods: ['generateContent'], thinking: true },
    { name: 'models/gemini-fixture-lite', displayName: 'Gemini Fixture Lite', supportedGenerationMethods: ['generateContent'] },
  ],
}
const geminiFetch: typeof fetch = (async () => jsonResponse(GEMINI_PAGE)) as unknown as typeof fetch
const OLLAMA_CAPS: Record<string, string[]> = { 'qwen3:8b': ['completion', 'tools', 'thinking'] }
const ollamaFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.endsWith('/api/tags')) return jsonResponse({ models: Object.keys(OLLAMA_CAPS).map(model => ({ model, name: model })) })
  if (url.endsWith('/api/version')) return jsonResponse({ version: '0.fixture' })
  if (url.endsWith('/api/ps')) return jsonResponse({ models: [] })
  if (url.endsWith('/api/show')) {
    const model = String((JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model ?? '')
    return jsonResponse({ capabilities: OLLAMA_CAPS[model] ?? [], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40_960 } })
  }
  return new Response('', { status: 404 })
}) as unknown as typeof fetch

openrouter.__resetOpenrouterCatalogueForTest()
await openrouter.refreshOpenrouterCatalogue('env', { force: true, fetchImpl: openrouterFetch })
gemini.__resetGeminiCatalogueForTest()
await gemini.refreshGeminiCatalogue('api-key', { force: true, fetchImpl: geminiFetch })
localDiscovery.__resetLocalDiscoveryForTest()
await localDiscovery.refreshLocalDiscovery({ force: true, fetchImpl: ollamaFetch, env: process.env })

console.log('the default output ceiling is the stated maximum up to 128k, for every model whose catalogue states it')
check('rig: the OpenRouter fixture catalogue landed', openrouter.getCachedOpenrouterCatalogue('env')?.models.length === 5)
check('rig: the Gemini fixture catalogue landed', gemini.getCachedGeminiCatalogue('api-key')?.models.length === 3)
check('rig: the Ollama fixture was discovered', localCatalogue.localRecordFor('local/qwen3:8b')?.server === 'ollama')
check('rig: the OpenRouter rows state their top_provider.max_completion_tokens', openrouter.openrouterMaxCompletionTokensFor('openrouter/wide/fixture-two-hundred') === 200_000 && openrouter.openrouterMaxCompletionTokensFor('openrouter/wide/fixture-ninety-six') === 96_000 && openrouter.openrouterMaxCompletionTokensFor('openrouter/wide/fixture-unstated') === undefined)
check('rig: the Gemini rows state their outputTokenLimit', gemini.geminiOutputTokenLimitFor('gemini-fixture-wide') === 131_072 && gemini.geminiOutputTokenLimitFor('gemini-fixture-ninety-six') === 96_000 && gemini.geminiOutputTokenLimitFor('gemini-fixture-lite') === undefined)
check('rig: the GPT display pins state outputMax on the 5.6/6 rows and nothing on gpt-5.5', gptPins.gptDisplayPin('gpt-5.6-sol')?.outputMax === 128_000 && gptPins.gptDisplayPin('gpt-6-astra')?.outputMax === 128_000 && gptPins.gptDisplayPin('gpt-5.5') !== undefined && gptPins.gptDisplayPin('gpt-5.5')?.outputMax === undefined)

type Pair = { default: number; upperLimit: number }
const pair = (m: string): Pair => caps.getModelMaxOutputTokens(m)
const stated = (m: string, upper: number, field: string): void => {
  const got = pair(m)
  check(`${m}: ${field} states ${upper.toLocaleString('en-US')} → default ${Math.min(upper, CEILING).toLocaleString('en-US')} (the stated maximum up to 128k), upper ${upper.toLocaleString('en-US')}`, got.default === Math.min(upper, CEILING) && got.upperLimit === upper, j(got))
}
const unstated = (m: string, why: string): void => {
  const got = pair(m)
  check(`${m}: ${why} → today's default stands (${TODAY_DEFAULT.toLocaleString('en-US')} / ${TODAY_UPPER.toLocaleString('en-US')}), never an invented number`, got.default === TODAY_DEFAULT && got.upperLimit === TODAY_UPPER, j(got))
}

section('§1 the owner: getModelMaxOutputTokens per family — default = min(stated maximum, 128,000) where the catalogue states one')
{
  stated('openrouter/wide/fixture-two-hundred', 200_000, 'OpenRouter top_provider.max_completion_tokens')
  stated('openrouter/wide/fixture-exact', 128_000, 'OpenRouter top_provider.max_completion_tokens')
  stated('openrouter/wide/fixture-ninety-six', 96_000, 'OpenRouter top_provider.max_completion_tokens')
  unstated('openrouter/wide/fixture-unstated', 'an OpenRouter row stating no max_completion_tokens')
  unstated('openrouter/anthropic/claude-opus-5', 'a carrier row stating nothing (never the first-party table by substring)')
  stated('gemini-fixture-wide', 131_072, 'Gemini outputTokenLimit')
  stated('gemini-fixture-ninety-six', 96_000, 'Gemini outputTokenLimit')
  unstated('gemini-fixture-lite', 'a Gemini row stating no outputTokenLimit')
  stated('gpt-5.6-sol', 128_000, 'the GPT display pin outputMax')
  stated('gpt-6-astra', 128_000, 'the GPT display pin outputMax')
  unstated('gpt-5.5', 'a GPT pin recording no outputMax')
  stated('claude-fable-5-1', 128_000, 'the first-party table')
  stated('claude-opus-5-5', 128_000, 'the first-party table')
  stated('claude-opus-5', 128_000, 'the first-party table')
  stated('claude-sonnet-5', 128_000, 'the first-party table')
  stated('claude-opus-4-6', 128_000, 'the first-party table')
  stated('claude-sonnet-4-6', 128_000, 'the first-party table')
  stated('claude-opus-4-5', 64_000, 'the first-party table (the 64k-max sibling)')
  stated('claude-haiku-4-5-20251001', 64_000, 'the first-party table')
  stated('claude-3-7-sonnet-20250219', 64_000, 'the first-party table')
  stated('claude-opus-4-1', 32_000, 'the first-party table')
  stated('claude-3-5-sonnet-20241022', 8_192, 'the first-party table')
  unstated('zz-unknown-model', 'an id outside every table')
  const local = pair('local/qwen3:8b')
  check(`local/qwen3:8b: a local record resolves to the fallback pair here (${local.default.toLocaleString('en-US')} / ${local.upperLimit.toLocaleString('en-US')}) — the local road reads its served window elsewhere`, local.default === TODAY_DEFAULT && local.upperLimit === TODAY_UPPER, j(local))
  for (const m of ['openrouter/wide/fixture-two-hundred', 'gemini-fixture-wide', 'gpt-5.6-sol', 'claude-opus-5-5', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-3-5-sonnet-20241022']) {
    const got = pair(m)
    check(`${m}: the default never exceeds the upper limit and never exceeds 128,000`, got.default <= got.upperLimit && got.default <= CEILING, j(got))
  }
}

section('§2 the thinking ceiling stays strictly below the output ceiling; the non-streaming cap is its own constant')
{
  for (const m of ['claude-opus-5-5', 'claude-opus-4-5', 'claude-sonnet-4-6', 'gemini-fixture-ninety-six', 'openrouter/wide/fixture-two-hundred']) {
    check(`${m}: the manual thinking ceiling is upperLimit − 1`, caps.getMaxThinkingTokensForModel(m) === pair(m).upperLimit - 1, String(caps.getMaxThinkingTokensForModel(m)))
  }
  check('MAX_NON_STREAMING_TOKENS is the separate 64,000 constant (left as it stands)', MAX_NON_STREAMING_TOKENS === 64_000, String(MAX_NON_STREAMING_TOKENS))
  const fitted = adjustParamsForNonStreaming({ max_tokens: 128_000, thinking: { type: 'enabled', budget_tokens: 127_999 } }, MAX_NON_STREAMING_TOKENS)
  check('the non-streaming re-fit caps a 128,000 request at 64,000 and keeps the budget strictly below it', fitted.max_tokens === 64_000 && fitted.thinking?.type === 'enabled' && fitted.thinking.budget_tokens === 63_999, j(fitted))
}

section('§3 the wire: the road\'s own body builder sends the default as max_tokens, thinking below it, the operator\'s override within the upper limit')
type Captured = { body: { model?: string; max_tokens?: number; thinking?: { type?: string; budget_tokens?: number } } }
const SENTINEL = new Error('request-captured')
let captured: Captured | null = null
let abortCapture: (() => void) | null = null
const captureFetch: typeof fetch = async (_input, init) => {
  captured = { body: init?.body ? (JSON.parse(String(init.body)) as Captured['body']) : {} }
  abortCapture?.()
  throw SENTINEL
}
async function captureRequest(model: string, thinkingConfig: { type: string; budgetTokens?: number }, env: Record<string, string> = {}): Promise<Captured | null> {
  captured = null
  const controller = new AbortController()
  abortCapture = () => controller.abort()
  const deadline = setTimeout(() => controller.abort(), 90_000)
  const savedEnv: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    savedEnv[k] = process.env[k]
    process.env[k] = v
  }
  const gen = queryModelWithStreaming({
    messages: [createUserMessage({ content: 'output ceiling fixture prompt' })],
    systemPrompt: asSystemPrompt(['You are the output ceiling fixture.']),
    thinkingConfig: thinkingConfig as never,
    tools: [],
    signal: controller.signal,
    options: {
      model,
      querySource: 'sdk',
      isNonInteractiveSession: true,
      fetchOverride: captureFetch as never,
      maxRetries: 0,
      getToolPermissionContext: async () => ({ mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} }) as never,
    } as never,
  })
  try {
    for await (const _ of gen) {
      void _
    }
  } catch {
    void 0
  }
  clearTimeout(deadline)
  abortCapture = null
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return captured
}
{
  const opus = await captureRequest('claude-opus-5-5', { type: 'adaptive' })
  check('opus-5-5: one request was captured for the model asked', opus !== null && opus.body.model === 'claude-opus-5-5', j(opus?.body.model))
  check('opus-5-5: the body carries max_tokens 128,000 — the stated 128k maximum, no longer the 64k default that left no room after thinking', opus?.body.max_tokens === 128_000, j(opus?.body.max_tokens))
  check('opus-5-5: the body\'s max_tokens is the resolver\'s default (one function, one number)', opus?.body.max_tokens === getMaxOutputTokensForModel('claude-opus-5-5') && getMaxOutputTokensForModel('claude-opus-5-5') === pair('claude-opus-5-5').default)
  const fable = await captureRequest('claude-fable-5-1', { type: 'adaptive' })
  check('fable-5-1: max_tokens 128,000 (the stated 128k maximum)', fable?.body.max_tokens === 128_000, j(fable?.body.max_tokens))
  const sibling = await captureRequest('claude-opus-4-5', { type: 'enabled', budgetTokens: 500_000 })
  check('opus-4-5 (the 64k-max sibling): max_tokens 64,000 — the stated maximum, below 128k', sibling?.body.max_tokens === 64_000, j(sibling?.body.max_tokens))
  check('opus-4-5: a budget model\'s thinking budget stays strictly below max_tokens even when the config asks above the ceiling (500,000 → 63,999)', sibling?.body.thinking?.type === 'enabled' && sibling.body.thinking.budget_tokens === 63_999 && sibling.body.thinking.budget_tokens < (sibling.body.max_tokens ?? 0), j(sibling?.body.thinking))
  const siblingDefaultBudget = await captureRequest('claude-opus-4-5', { type: 'enabled' })
  check('opus-4-5: with no budget pinned the budget is the ceiling − 1 (63,999 under 64,000)', siblingDefaultBudget?.body.thinking?.budget_tokens === 63_999 && siblingDefaultBudget.body.max_tokens === 64_000, j({ max_tokens: siblingDefaultBudget?.body.max_tokens, thinking: siblingDefaultBudget?.body.thinking }))
  const legacy = await captureRequest('claude-opus-4-1', { type: 'adaptive' })
  check('opus-4-1: a stated 32k maximum stays max_tokens 32,000 (the rule raises nothing above what the model states)', legacy?.body.max_tokens === 32_000, j(legacy?.body.max_tokens))
  const raised = await captureRequest('claude-opus-5-5', { type: 'adaptive' }, { MERCURY_MAX_OUTPUT_TOKENS: '100000' })
  check('the operator\'s MERCURY_MAX_OUTPUT_TOKENS=100000 still sets the request (100,000 on opus-5-5)', raised?.body.max_tokens === 100_000, j(raised?.body.max_tokens))
  const lowered = await captureRequest('claude-opus-5-5', { type: 'adaptive' }, { MERCURY_MAX_OUTPUT_TOKENS: '8000' })
  check('the operator can still lower it (8,000 on opus-5-5)', lowered?.body.max_tokens === 8_000, j(lowered?.body.max_tokens))
  const overTop = await captureRequest('claude-opus-5-5', { type: 'adaptive' }, { MERCURY_MAX_OUTPUT_TOKENS: '500000' })
  check('the override still cannot exceed the upper limit: 500,000 caps at 128,000 on opus-5-5', overTop?.body.max_tokens === 128_000, j(overTop?.body.max_tokens))
  const overSibling = await captureRequest('claude-opus-4-5', { type: 'adaptive' }, { MERCURY_MAX_OUTPUT_TOKENS: '100000' })
  check('…and at the sibling\'s own ceiling: 100,000 caps at 64,000 on opus-4-5', overSibling?.body.max_tokens === 64_000, j(overSibling?.body.max_tokens))
}

section('§4 the compaction request follows: neither fold lane sends an override, so its max_tokens is the session request\'s own (the default, or the operator\'s MERCURY_MAX_OUTPUT_TOKENS)')
{
  const { compactConversation, shouldRideCacheSharingFork } = await import('../../src/services/compact/compact.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
  let uuidSeq = 0
  const nextUuid = (): string => `00000000-0000-4000-a000-${String(++uuidSeq).padStart(12, '0')}`
  const assistantRow = (text: string): unknown => {
    const id = `msg_${nextUuid().slice(-6)}`
    return { type: 'assistant', uuid: nextUuid(), requestId: `req_${id}`, timestamp: new Date().toISOString(), message: { id, type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } } }
  }
  const messages = (): unknown[] => [createUserMessage({ content: 'please bump the version and run the tests' }), assistantRow('Bumped the version and ran the suite — all green.'), createUserMessage({ content: 'now write the changelog entry' })]
  const makeContext = (model: string) => {
    const appState = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const }, sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'high' }
    const readFileState = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
    const abort = new AbortController()
    return { abortController: abort, getAppState: () => appState, setAppState: () => {}, messages: [], agentType: undefined, agentId: undefined, readFileState, options: { tools: [], mcpClients: [], engineModel: model, maxThinkingTokens: 0, thinkingConfig: { type: 'disabled' as const }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
  }
  const runFold = async (model: string, road: 'fork' | 'direct'): Promise<{ error?: Error; body?: { max_tokens?: number; model?: string }; lanes: string[] }> => {
    const ctx = makeContext(model)
    const rows = messages()
    const posture = asSystemPrompt(['You are the output ceiling fold fixture.'])
    const cacheSafe = road === 'fork' ? { systemPrompt: posture, userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: rows } : { systemPrompt: posture }
    const before = fixture.captured.length
    let error: Error | undefined
    try {
      await compactConversation(rows as never, ctx as never, cacheSafe as never, true)
    } catch (err) {
      error = err as Error
    }
    const since = fixture.captured.slice(before)
    const hit = since.filter(h => h.lane === 'anthropic-seat').pop()
    return { error, body: hit?.body as { max_tokens?: number; model?: string } | undefined, lanes: since.map(h => `${h.lane} ${h.path}`) }
  }
  const foldDetail = (r: { error?: Error; lanes: string[] }): string => `${r.error ? `${r.error.name}: ${r.error.message.slice(0, 200)}` : 'no error'} · wire hits: ${r.lanes.join(', ') || 'none'}`
  check('opus-5-5 rides the cache-sharing fork under adaptive thinking', shouldRideCacheSharingFork('claude-opus-5-5', { type: 'adaptive' }) === true)
  const fork = await runFold('claude-opus-5-5', 'fork')
  check('opus-5-5/fork: the fold resolved and reached the home wire', fork.error === undefined && fork.body !== undefined && fork.body.model === 'claude-opus-5-5', foldDetail(fork))
  check('opus-5-5/fork: the compaction request\'s max_tokens is the new default, 128,000 (no override rides the fork)', fork.body?.max_tokens === 128_000, j(fork.body?.max_tokens))
  const direct = await runFold('claude-opus-5-5', 'direct')
  check('opus-5-5/direct: the fold resolved and reached the home wire', direct.error === undefined && direct.body !== undefined, foldDetail(direct))
  check(`opus-5-5/direct: the direct lane sends the session's own max_tokens = ${getMaxOutputTokensForModel('claude-opus-5-5').toLocaleString('en-US')} (no override rides the direct lane either)`, direct.body?.max_tokens === getMaxOutputTokensForModel('claude-opus-5-5'), j(direct.body?.max_tokens))
}

section('§5 the display truth reads the one owner: the capability record, the context resolution\'s output reserve')
{
  for (const [m, def, upper] of [
    ['claude-opus-5-5', 128_000, 128_000],
    ['claude-fable-5-1', 128_000, 128_000],
    ['claude-opus-4-5', 64_000, 64_000],
    ['gemini-fixture-ninety-six', 96_000, 96_000],
    ['openrouter/wide/fixture-two-hundred', 128_000, 200_000],
    ['gpt-5.6-sol', 128_000, 128_000],
    ['zz-unknown-model', 32_000, 64_000],
  ] as const) {
    const record = caps.resolveModelCapabilities(m)
    check(`${m}: the capability record says outputDefault ${def.toLocaleString('en-US')} · outputMax ${upper.toLocaleString('en-US')} · maxThinkingTokens ${(upper - 1).toLocaleString('en-US')}`, record.context.outputDefault === def && record.context.outputMax === upper && record.context.maxThinkingTokens === upper - 1, j(record.context))
    check(`${m}: the context resolution's outputReserve is the same default`, caps.resolveContextWindow(m).outputReserve === def, String(caps.resolveContextWindow(m).outputReserve))
  }
}

section('§6 the shape: one rule in the owner, every road reads it')
{
  const edge = src('src/utils/model/capabilities.ts')
  check('the owner names the 128,000 ceiling once', /STATED_OUTPUT_DEFAULT_CEILING = 128_000/.test(edge))
  check('the Meta pin, the GPT pin, the carrier rows, and the first-party table with the capability rung (one shared return) resolve through the one stated-output helper: its definition and four call sites', (edge.match(/statedOutputTokens\(/g) ?? []).length === 5 && edge.includes('return statedOutputTokens(metaOut)') && edge.includes('return statedOutputTokens(gptPinOut)') && edge.includes('return statedOutputTokens(statedOut)') && edge.includes('return statedOutputTokens(upperLimit)'), String((edge.match(/statedOutputTokens\(/g) ?? []).length))
  check('the fallback pair for an unstated id is unchanged (32,000 / 64,000)', edge.includes('const MAX_OUTPUT_TOKENS_DEFAULT = 32_000') && edge.includes('const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000'))
  const core = src('src/services/providers/anthropic/streamCore.ts')
  check('the env door still validates MERCURY_MAX_OUTPUT_TOKENS against the default and the upper limit', core.includes("'MERCURY_MAX_OUTPUT_TOKENS',\n    process.env.MERCURY_MAX_OUTPUT_TOKENS,\n    maxOutputTokens.default,\n    maxOutputTokens.upperLimit,"))
  check('the budget road still clamps thinking to max_tokens − 1', core.includes('thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)'))
  const compact = src('src/services/compact/compact.ts')
  check('neither compaction lane overrides the output ceiling: the fold rides the session request\'s own', !compact.includes('maxOutputTokensOverride:') && !compact.includes('maxOutputTokens:') && !compact.includes('getModelMaxOutputTokens'))
}

await fixture.close()
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-output-ceiling — ${checks} checks${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
