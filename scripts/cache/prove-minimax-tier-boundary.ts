import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import type { AssistantMessage } from '../../src/engine/message-shapes/message.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MINIMAX_API_KEY = 'proof-key-minimax-tier-not-a-real-key'
let promptTokens = 511_999
const cachedTokens = 200_000
const outputTokens = 1000
let requests = 0
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req: Request) {
  const path = new URL(req.url).pathname
  assert.equal(req.headers.get('authorization'), `Bearer ${process.env.MINIMAX_API_KEY}`, 'the MiniMax request must carry the MINIMAX_API_KEY as a Bearer token; check the MiniMax client under src/models/roads/minimax')
  if (path === '/v1/models') return Response.json({ data: [{ id: 'MiniMax-M3', owned_by: 'minimax' }] })
  if (path === '/v1/token_plan/remains') return Response.json({ model_remains: [], base_resp: { status_code: 0 } })
  assert.equal(path, '/v1/chat/completions', `the MiniMax client called an unexpected path ${path}; the fixture serves only /v1/models, /v1/token_plan/remains and /v1/chat/completions`)
  const body = await req.json() as Record<string, any>
  assert.equal(body.model, 'MiniMax-M3', 'the minimax-m3 alias must be sent to the server as MiniMax-M3; check the MiniMax model naming under src/models/roads/minimax')
  assert.equal(body.stream_options.include_usage, true, 'the MiniMax request must ask for stream usage (stream_options.include_usage); check the request builder under src/models/roads/minimax')
  assert.equal(body.service_tier, undefined, 'the MiniMax request body must not carry a service_tier; check the request builder under src/models/roads/minimax')
  assert.deepEqual(body.thinking, { type: 'adaptive' }, 'the MiniMax request body must carry thinking {type: adaptive} for this thinkingConfig and effort; check the request builder under src/models/roads/minimax')
  requests++
  const chunk = (delta: unknown, finish_reason: string | null, extra = {}) => `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`
  return new Response(chunk({ content: 'MINIMAX-TIER-SERVED' }, null) + chunk({}, 'stop', { usage: { prompt_tokens: promptTokens, completion_tokens: outputTokens, prompt_tokens_details: { cached_tokens: cachedTokens } } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MERCURY_MINIMAX_API_BASE = `http://127.0.0.1:${server.port}/v1`
try {
  const { enableConfigs } = await import('../../src/platform/settings/config.ts'); enableConfigs()
  const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
  const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
  const { routedCallModel } = await import('../../src/models/roads/callModelRouter.ts')
  const { getModelCosts, calculateUSDCost } = await import('../../src/models/usage/modelCost.ts')
  const { getModelUsage } = await import('../../src/boot/process-state/processState.ts')
  const rates = (model: string, total: number) => {
    const value = getModelCosts(model, { promptTokens: total })
    return [value.inputTokens, value.promptCacheReadTokens, value.outputTokens]
  }
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}; the cost must follow the tier for this prompt size, fix calculateUSDCost / getModelCosts or the minimax entry of PRICING_OWNERS in src/models/usage/modelCost.ts, or the pin in src/models/facts/pins/minimaxPins.ts`)
  for (const [total, inputRate, cacheRate, outputRate] of [[511_999, 0.3, 0.06, 1.2], [512_000, 0.3, 0.06, 1.2], [512_001, 0.6, 0.12, 2.4]] as const) {
    promptTokens = total
    const before = getModelUsage()['MiniMax-M3']?.costUSD ?? 0
    const rows: AssistantMessage[] = []
    for await (const row of routedCallModel({ messages: [createUserMessage({ content: 'hello fixture' })], systemPrompt: asSystemPrompt(['Fixture']), tools: [], thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, signal: new AbortController().signal, options: { model: 'minimax-m3', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'max' } as never })) {
      if (row.type === 'assistant') rows.push(row as AssistantMessage)
    }
    assert.ok(!rows.some(row => row.isApiErrorMessage), `the routed MiniMax call (routedCallModel in src/models/roads/callModelRouter.ts) returned an API error row against the fixture server: ${JSON.stringify(rows)}`)
    const usage = rows.at(-1)!.message.usage
    assert.deepEqual([usage.input_tokens, usage.cache_read_input_tokens, usage.output_tokens], [total - cachedTokens, cachedTokens, outputTokens], `at ${total} prompt tokens the MiniMax stream's usage must reach the message as uncached input, cache reads and output; fix the MiniMax usage mapping under src/models/roads/minimax or the chat-completions reader it uses`)
    const expected = ((total - cachedTokens) * inputRate + cachedTokens * cacheRate + outputTokens * outputRate) / 1e6
    near(getModelUsage()['MiniMax-M3']!.costUSD - before, expected)
    near(calculateUSDCost('MiniMax-M3', usage as never), expected)
    for (const id of ['minimax-m3', 'MiniMax-M3', 'minimax-m3[1m]']) assert.deepEqual(rates(id, total), [inputRate, cacheRate, outputRate], `${id} at ${total} input tokens: getModelCosts in src/models/usage/modelCost.ts must resolve every spelling of the model to the same tier (the minimax entry of PRICING_OWNERS, pin in src/models/facts/pins/minimaxPins.ts, long context above 512000)`)
    near(calculateUSDCost('minimax-m3', { input_tokens: total, output_tokens: 0 }), total * inputRate / 1e6)
    near(calculateUSDCost('minimax-m3', { input_tokens: 0, cache_read_input_tokens: total, output_tokens: 0 }), total * cacheRate / 1e6)
    near(calculateUSDCost('minimax-m3', { input_tokens: total, output_tokens: outputTokens }) - calculateUSDCost('minimax-m3', { input_tokens: total, output_tokens: 0 }), outputTokens * outputRate / 1e6)
    console.log(`[PASS] ${total}: input, cached input, output and routed ledger use ${inputRate}/${cacheRate}/${outputRate}`)
  }
  assert.equal(requests, 3, `the fixture server should have served exactly 3 chat-completions requests, one per boundary size; it served ${requests}, so routedCallModel in src/models/roads/callModelRouter.ts retried or skipped a call`)
  assert.deepEqual(rates('grok-4.7', 199_999), [2, 0.5, 6], 'xAI below 200000 prompt tokens must price at the base tier; fix the xai entry of PRICING_OWNERS in src/models/usage/modelCost.ts or the grok-4.7 pin in src/models/facts/pins/xaiPins.ts')
  assert.deepEqual(rates('grok-4.7', 200_000), [4, 1, 12], 'xAI at exactly 200000 prompt tokens must already price at the long-context tier (inclusive boundary); fix the xai entry of PRICING_OWNERS in src/models/usage/modelCost.ts')
  assert.deepEqual(rates('grok-4.7', 200_001), [4, 1, 12], 'xAI above 200000 prompt tokens must price at the long-context tier; fix the xai entry of PRICING_OWNERS in src/models/usage/modelCost.ts')
  console.log('[PASS] xAI retains its inclusive expensive-tier boundary')
  assert.deepEqual(rates('zen/grok-4.7', 200_000), [2, 0.5, 6], 'Zen must stay on the base tier at exactly 200000 prompt tokens (the tier changes only above the threshold); fix the zen entry of PRICING_OWNERS in src/models/usage/modelCost.ts or the pin in src/models/facts/pins/zenPins.ts')
  assert.deepEqual(rates('zen/grok-4.7', 200_001), [4, 1, 12], 'Zen must price at the long-context tier above 200000 prompt tokens; fix the zen entry of PRICING_OWNERS in src/models/usage/modelCost.ts or the pin in src/models/facts/pins/zenPins.ts')
  assert.deepEqual(rates('zen/gpt-6-astra', 271_999), [10, 1, 50], 'Zen gpt-6-astra must price at the base tier below 272000 prompt tokens; fix src/models/facts/pins/zenPins.ts or the zen entry of PRICING_OWNERS in src/models/usage/modelCost.ts')
  assert.deepEqual(rates('zen/gpt-6-astra', 272_000), [10, 1, 50], 'Zen gpt-6-astra must stay on the base tier at exactly 272000 prompt tokens (long context applies only above it); fix the zen entry of PRICING_OWNERS in src/models/usage/modelCost.ts')
  assert.deepEqual(rates('zen/gpt-6-astra', 272_001), [20, 2, 75], 'Zen gpt-6-astra must price at the long-context tier above 272000 prompt tokens; fix the zen entry of PRICING_OWNERS in src/models/usage/modelCost.ts or the pin in src/models/facts/pins/zenPins.ts')
  console.log('[PASS] Zen changes tier at more than its threshold, as its page prices it (opencode.ai/docs/zen, read 2026-11-17)')
  console.log('MINIMAX TIER BOUNDARY GREEN')
} finally {
  server.stop(true)
  rmSync(proofHome, { recursive: true, force: true })
}
