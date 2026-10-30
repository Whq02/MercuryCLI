import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import type { AssistantMessage } from '../../src/types/message.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MINIMAX_API_KEY = 'proof-key-minimax-tier-not-a-real-key'
let promptTokens = 511_999
const cachedTokens = 200_000
const outputTokens = 1000
let requests = 0
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req: Request) {
  const path = new URL(req.url).pathname
  assert.equal(req.headers.get('authorization'), `Bearer ${process.env.MINIMAX_API_KEY}`)
  if (path === '/v1/models') return Response.json({ data: [{ id: 'MiniMax-M3', owned_by: 'minimax' }] })
  if (path === '/v1/token_plan/remains') return Response.json({ model_remains: [], base_resp: { status_code: 0 } })
  assert.equal(path, '/v1/chat/completions')
  const body = await req.json() as Record<string, any>
  assert.equal(body.model, 'MiniMax-M3')
  assert.equal(body.stream_options.include_usage, true)
  assert.equal(body.service_tier, undefined)
  assert.deepEqual(body.thinking, { type: 'adaptive' })
  requests++
  const chunk = (delta: unknown, finish_reason: string | null, extra = {}) => `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`
  return new Response(chunk({ content: 'MINIMAX-TIER-SERVED' }, null) + chunk({}, 'stop', { usage: { prompt_tokens: promptTokens, completion_tokens: outputTokens, prompt_tokens_details: { cached_tokens: cachedTokens } } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MERCURY_MINIMAX_API_BASE = `http://127.0.0.1:${server.port}/v1`
try {
  const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { getModelCosts, calculateUSDCost } = await import('../../src/utils/modelCost.ts')
  const { getModelUsage } = await import('../../src/bootstrap/state.ts')
  const rates = (model: string, total: number) => {
    const value = getModelCosts(model, { promptTokens: total })
    return [value.inputTokens, value.promptCacheReadTokens, value.outputTokens]
  }
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)
  for (const [total, inputRate, cacheRate, outputRate] of [[511_999, 0.3, 0.06, 1.2], [512_000, 0.3, 0.06, 1.2], [512_001, 0.6, 0.12, 2.4]] as const) {
    promptTokens = total
    const before = getModelUsage()['MiniMax-M3']?.costUSD ?? 0
    const rows: AssistantMessage[] = []
    for await (const row of routedCallModel({ messages: [createUserMessage({ content: 'hello fixture' })], systemPrompt: asSystemPrompt(['Fixture']), tools: [], thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, signal: new AbortController().signal, options: { model: 'minimax-m3', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'max' } as never })) {
      if (row.type === 'assistant') rows.push(row as AssistantMessage)
    }
    assert.ok(!rows.some(row => row.isApiErrorMessage), JSON.stringify(rows))
    const usage = rows.at(-1)!.message.usage
    assert.deepEqual([usage.input_tokens, usage.cache_read_input_tokens, usage.output_tokens], [total - cachedTokens, cachedTokens, outputTokens])
    const expected = ((total - cachedTokens) * inputRate + cachedTokens * cacheRate + outputTokens * outputRate) / 1e6
    near(getModelUsage()['MiniMax-M3']!.costUSD - before, expected)
    near(calculateUSDCost('MiniMax-M3', usage as never), expected)
    for (const id of ['minimax-m3', 'MiniMax-M3', 'minimax-m3[1m]']) assert.deepEqual(rates(id, total), [inputRate, cacheRate, outputRate], `${id} at ${total} input tokens`)
    near(calculateUSDCost('minimax-m3', { input_tokens: total, output_tokens: 0 }), total * inputRate / 1e6)
    near(calculateUSDCost('minimax-m3', { input_tokens: 0, cache_read_input_tokens: total, output_tokens: 0 }), total * cacheRate / 1e6)
    near(calculateUSDCost('minimax-m3', { input_tokens: total, output_tokens: outputTokens }) - calculateUSDCost('minimax-m3', { input_tokens: total, output_tokens: 0 }), outputTokens * outputRate / 1e6)
    console.log(`[PASS] ${total}: input, cached input, output and routed ledger use ${inputRate}/${cacheRate}/${outputRate}`)
  }
  assert.equal(requests, 3)
  for (const id of ['grok-4.7', 'zen/grok-4.7']) {
    assert.deepEqual(rates(id, 199_999), [2, 0.5, 6])
    assert.deepEqual(rates(id, 200_000), [4, 1, 12])
    assert.deepEqual(rates(id, 200_001), [4, 1, 12])
  }
  assert.deepEqual(rates('zen/gpt-6-astra', 271_999), [10, 1, 50])
  assert.deepEqual(rates('zen/gpt-6-astra', 272_000), [20, 2, 75])
  assert.deepEqual(rates('zen/gpt-6-astra', 272_001), [20, 2, 75])
  console.log('[PASS] xAI and Zen retain their inclusive expensive-tier boundaries')
  console.log('MINIMAX TIER BOUNDARY GREEN')
} finally {
  server.stop(true)
  rmSync(proofHome, { recursive: true, force: true })
}
