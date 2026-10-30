import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const aliases = ['mistral-large-4', 'mistral-large-4-0']
let usage = { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request: Request) {
  assert.equal(request.headers.get('authorization'), 'Bearer proof-key-mistral-price-not-real')
  if (new URL(request.url).pathname.endsWith('/models')) return Response.json({ data: aliases.map(id => ({ id, capabilities: { completion_chat: true } })) })
  const body = await request.json() as { model: string }
  return new Response(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: 'priced' }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MISTRAL_API_KEY = 'proof-key-mistral-price-not-real'
process.env.MERCURY_MISTRAL_API_BASE = `http://127.0.0.1:${server.port}/v1`
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { getModelPricingString, calculateUSDCost, resolveModelPricing } = await import('../../src/utils/modelCost.js')
const { getTotalCost, resetCostState } = await import('../../src/cost-tracker.js')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
try {
  for (const model of aliases) {
    assert.equal(getModelPricingString(model), '$0.70/$2.10 per Mtok')
    const costs = resolveModelPricing(model).costs
    assert.deepEqual([costs.inputTokens, costs.promptCacheReadTokens, costs.outputTokens], [0.7, 0.07, 2.1])
    for (const [input, cached, output, expected] of [[1000000, 0, 0, 0.7], [0, 1000000, 0, 0.07], [0, 0, 1000000, 2.1]]) {
      assert.equal(calculateUSDCost(model, { input_tokens: input!, cache_read_input_tokens: cached!, output_tokens: output! }), expected)
      resetCostState()
      usage = { prompt_tokens: input! + cached!, completion_tokens: output!, prompt_tokens_details: { cached_tokens: cached! } }
      let settled = false
      for await (const event of routedCallModel({ messages: [createUserMessage({ content: 'Price fixture' })], systemPrompt: ['Fixture'], thinkingConfig: { type: 'disabled' }, tools: [], signal: new AbortController().signal, options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } } as never)) {
        if (event.type === 'assistant') {
          assert.ok(!event.isApiErrorMessage)
          settled = true
        }
      }
      assert.ok(settled)
      assert.equal(getTotalCost(), expected)
      console.log(`PASS ${model}: input=${input} cache=${cached} output=${output} ledger=$${expected}`)
    }
  }
  console.log('MISTRAL LARGE PRICE GREEN')
} finally {
  server.stop(true)
  rmSync(proofHome, { recursive: true, force: true })
}
