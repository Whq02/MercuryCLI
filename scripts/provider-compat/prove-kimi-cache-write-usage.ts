import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = proofHome
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MOONSHOT_API_KEY = 'proof-key-kimi-cache-not-a-real-key'
let usage: Record<string, unknown> = { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 300 } }
let headers: Record<string, string> = {}
let mode: 'text' | 'tools' | 'rate' | 'truncated' = 'text'
const captures: Array<{ path: string; body: Record<string, any> }> = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req: Request) {
  const path = new URL(req.url).pathname
  if (path.endsWith('/models')) return Response.json({ data: [{ id: path.startsWith('/coding/') ? 'k3' : 'kimi-k3', owned_by: 'moonshot' }] })
  if (path === '/coding/v1/usages') return Response.json({ limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '25', remaining: '75' } }] })
  if (path === '/v1/users/me/balance') return Response.json({ data: { available_balance: 12 } })
  assert.ok(path === '/v1/chat/completions' || path === '/coding/v1/chat/completions', path)
  assert.equal(req.headers.get('authorization'), `Bearer ${path.startsWith('/coding/') ? 'proof-kimi-plan-token' : process.env.MOONSHOT_API_KEY}`)
  const body = await req.json() as Record<string, any>
  captures.push({ path, body })
  assert.equal(body.stream_options.include_usage, true)
  assert.equal(body.reasoning_effort, 'max')
  if (mode === 'rate') return Response.json({ error: { code: 'rate_limit_exceeded', message: 'rate limit reached' } }, { status: 429, headers: { 'Retry-After': '3600' } })
  const chunk = (delta: unknown, finish_reason: string | null = null, extra = {}) => `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`
  let stream = chunk({ reasoning_content: 'Keep the cached prefix.' })
  stream += mode === 'tools' ? chunk({ tool_calls: [{ index: 0, id: 'kimi-cache-call', type: 'function', function: { name: 'FixtureEcho', arguments: '{"text":"hello"}' } }] }) : chunk({ content: 'KIMI-CACHE-SERVED' })
  if (mode !== 'truncated') stream += chunk({}, mode === 'tools' ? 'tool_calls' : 'stop') + `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', ...headers } })
} })
process.env.MERCURY_MOONSHOT_API_BASE = `http://127.0.0.1:${server.port}/v1`
process.env.MERCURY_MOONSHOT_CODING_BASE = `http://127.0.0.1:${server.port}/coding/v1`
process.env.MERCURY_MOONSHOT_OAUTH_BASE = `http://127.0.0.1:${server.port}/auth`
try {
  const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { compatChatCallModel, mapCompatUsageToAnthropic } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
  const { decodeCompatUsage } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
  const { moonshotLaneProfile } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
  const { buildMoonshotExtras } = await import('../../src/services/providers/openaicompat/compatWire.ts')
  const { calculateUSDCost, resolveModelPricing } = await import('../../src/utils/modelCost.ts')
  const { getModelUsage } = await import('../../src/bootstrap/state.ts')
  const { usageForProvider, refreshProviderUsage } = await import('../../src/services/providers/providerUsage.ts')
  const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)
  async function run(options: { ttl?: '1h'; model?: string; messages?: Message[]; signal?: AbortSignal } = {}): Promise<AssistantMessage[]> {
    const params = { messages: options.messages ?? [createUserMessage({ content: 'hello fixture' })], systemPrompt: asSystemPrompt(['Fixture']), tools: [tool], thinkingConfig: { type: 'enabled' as const, budgetTokens: 4096 }, signal: options.signal ?? new AbortController().signal, options: { model: options.model ?? 'kimi-k3', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'max' } as never }
    const stream = options.ttl ? compatChatCallModel({ ...moonshotLaneProfile, buildExtras: args => ({ ...buildMoonshotExtras(args), prompt_cache_options: { mode: 'implicit', ttl: options.ttl } }) }, params) : routedCallModel(params)
    const rows: AssistantMessage[] = []
    for await (const row of stream) if (row.type === 'assistant') rows.push(row as AssistantMessage)
    return rows
  }
  function buckets(rows: AssistantMessage[], read: number, write: number, oneHour = 0, model = 'kimi-k3'): number {
    assert.ok(!rows.some(row => row.isApiErrorMessage), JSON.stringify(rows))
    const settled = rows.at(-1)!.message.usage
    assert.equal(settled.cache_read_input_tokens, read)
    assert.equal(settled.cache_creation_input_tokens, write, 'cache writes survive final streaming usage')
    assert.equal(settled.input_tokens, 1000 - read - write)
    assert.equal(settled.input_tokens + (settled.cache_read_input_tokens ?? 0) + (settled.cache_creation_input_tokens ?? 0), 1000)
    assert.equal(settled.output_tokens, 100)
    if (write > 0) {
      assert.equal(settled.cache_creation?.ephemeral_1h_input_tokens, oneHour)
      assert.equal(settled.cache_creation?.ephemeral_5m_input_tokens, write - oneHour)
    }
    return calculateUSDCost(model, settled as never)
  }

  const first = await run()
  near(buckets(first, 400, 300), 0.00342)
  assert.equal(captures[0]!.body.model, 'kimi-k3')
  assert.equal(captures[0]!.body.prompt_cache_options, undefined, 'normal Moonshot requests retain the default 5m TTL')
  const ledger = getModelUsage()['kimi-k3']!
  assert.deepEqual([ledger.inputTokens, ledger.cacheReadInputTokens, ledger.cacheCreationInputTokens, ledger.outputTokens], [300, 400, 300, 100])
  near(ledger.costUSD, 0.00342)
  near(ledger.costUSD, calculateUSDCost('kimi-k3', { input_tokens: 600, cache_read_input_tokens: 400, output_tokens: 100 }))
  console.log('[PASS] final stream and session ledger conserve three input buckets without a second write charge')

  headers = { 'Msh-Usage-Cache-Write-Tokens-5m': '0', 'Msh-Usage-Cache-Write-Tokens-1h': '300' }
  const before = getModelUsage()['kimi-k3']!.costUSD
  near(buckets(await run({ ttl: '1h' }), 400, 300, 300), 0.00432)
  near(getModelUsage()['kimi-k3']!.costUSD - before, 0.00432)
  assert.deepEqual(captures.at(-1)!.body.prompt_cache_options, { mode: 'implicit', ttl: '1h' })
  headers = { 'Msh-Usage-Cache-Write-Tokens-5m': '200', 'Msh-Usage-Cache-Write-Tokens-1h': '100' }
  near(buckets(await run(), 400, 300, 100), 0.00372)
  headers = { 'Msh-Usage-Cache-Write-Tokens-5m': '300', 'Msh-Usage-Cache-Write-Tokens-1h': '0' }
  near(buckets(await run(), 400, 300), 0.00342)
  console.log('[PASS] K3 5m, 1h and mixed write TTLs use disjoint $3/$6 write rates')

  headers = {}
  for (const [details, read, write] of [
    [{ cached_tokens: 400 }, 400, 0],
    [{ cache_write_tokens: 300 }, 0, 300],
    [{}, 0, 0],
    [undefined, 0, 0],
    [{ cached_tokens: 0, cache_write_tokens: 0 }, 0, 0],
  ] as const) {
    usage = { prompt_tokens: 1000, completion_tokens: 100, ...(details !== undefined ? { prompt_tokens_details: details } : {}) }
    near(buckets(await run(), read, write), ((1000 - read) * 3 + read * 0.3 + 100 * 15) / 1e6)
  }
  const legacy = mapCompatUsageToAnthropic(decodeCompatUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 400 }))
  assert.deepEqual([legacy.input_tokens, legacy.cache_read_input_tokens, legacy.cache_creation_input_tokens], [600, 400, 0])
  assert.equal(decodeCompatUsage({}), undefined)
  console.log('[PASS] missing old/new fields and legacy read fields keep their accounting')

  usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 300 } }
  mode = 'tools'
  const called = await run()
  buckets(called, 400, 300)
  mode = 'text'
  buckets(await run({ messages: [...called, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'kimi-cache-call', content: 'hello' }] })] }), 400, 300)
  const history = captures.at(-1)!.body.messages
  assert.ok(history.some((row: any) => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'kimi-cache-call' && row.reasoning_content === 'Keep the cached prefix.'))
  assert.ok(history.some((row: any) => row.role === 'tool' && row.tool_call_id === 'kimi-cache-call'))
  mode = 'rate'
  const beforeRate = captures.length
  assert.ok((await run()).some(row => row.error === 'rate_limit'))
  mode = 'text'
  buckets(await run(), 400, 300)
  assert.equal(captures.length, beforeRate + 2)
  mode = 'truncated'
  assert.ok((await run()).some(row => row.isApiErrorMessage))
  const aborted = new AbortController(); aborted.abort()
  const beforeAbort = captures.length
  assert.deepEqual(await run({ signal: aborted.signal }), [])
  assert.equal(captures.length, beforeAbort)
  mode = 'text'
  console.log('[PASS] tool replay, Retry-After, served retry, incomplete stream and cancellation retain their contracts')

  await refreshProviderUsage('moonshot', { force: true, reason: 'operator' })
  const api = usageForProvider('moonshot')
  assert.equal(api.sourceKind, 'api-key')
  assert.equal(api.shape, 'api-spend')
  assert.equal(api.balance?.display, 'USD 12')
  const { writeMoonshotTokens } = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
  writeMoonshotTokens({ accessToken: 'proof-kimi-plan-token', accessTokenExpiresAtMs: Date.now() + 3_600_000 }, 'global')
  delete process.env.MOONSHOT_API_KEY
  await run({ model: 'k3' })
  await refreshProviderUsage('moonshot', { force: true, reason: 'operator' })
  const plan = usageForProvider('moonshot')
  assert.equal(captures.at(-1)!.path, '/coding/v1/chat/completions')
  assert.equal(plan.sourceKind, 'oauth')
  assert.equal(plan.shape, 'subscription-windows')
  assert.equal(plan.balance, undefined)
  assert.equal(plan.windows[0]?.usedPct, 25)
  assert.equal(resolveModelPricing('k3').basis, 'unpriced')
  console.log('[PASS] coding-plan windows and endpoint remain separate from API balance and token prices')
  console.log('KIMI CACHE WRITE USAGE GREEN')
} finally {
  server.stop(true)
  rmSync(proofHome, { recursive: true, force: true })
}
