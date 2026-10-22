import assert from 'node:assert/strict'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { startEngineRules } from './fixtures/engineRules.mjs'

const f = await llmhostFixture()
const fetchBefore = globalThis.fetch
try {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    assert.equal(url.hostname, '127.0.0.1')
    return fetchBefore(input, init)
  }) as typeof fetch
  const { updateSettingsForSource } = await import(`${f.root}/src/utils/settings/settings.ts`)
  const { routedCallModel } = await import(`${f.root}/src/services/providers/callModelRouter.ts`)
  const { asSystemPrompt } = await import(`${f.root}/src/utils/systemPromptType.ts`)
  const { getUsageForModel, resetCostState } = await import(`${f.root}/src/cost-tracker.ts`)
  for (const dialect of ['llamacpp', 'vllm', 'sglang', 'ollama']) {
    const engine = await startEngineRules(dialect)
    try {
      const model = `compat/usage-${dialect}/${engine.model}`
      assert.equal(updateSettingsForSource('userSettings', { compatProvider: { [`usage-${dialect}`]: { baseUrl: engine.baseUrl, dialect, models: [engine.model] } } }).error, null)
      for (const mode of ['cancel-text', 'cancel-thinking', 'return', 'measured-cancel', 'cut', 'complete', 'pre-cancel']) {
        resetCostState()
        const controller = new AbortController()
        const before = engine.requests.length
        const measured = mode === 'measured-cancel'
        if (mode === 'pre-cancel') controller.abort()
        else engine.script([{ ...(mode === 'cancel-thinking' ? { reasoning: 'reasoning before cancellation' } : {}), ...(measured ? { usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 45 }, completion_tokens_details: { reasoning_tokens: 7 }, cost: 0.0123 } } : {}), ...(mode === 'cut' ? { cut: true } : mode === 'complete' ? {} : { hold: true }) }])
        const rows: any[] = []
        const cancelAt = mode === 'cancel-thinking' ? 'thinking_delta' : 'text_delta'
        const deadline = setTimeout(() => controller.abort(), 10000)
        try {
          for await (const event of routedCallModel({ messages: [f.createUserMessage({ content: 'Account for this whole interrupted request.' })], tools: [], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: { type: 'enabled', budgetTokens: 8192 }, signal: controller.signal,
            options: { model, effortValue: 'max', ownerKey: `usage-${dialect}`, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } } as never)) {
            rows.push(event)
            if (event.type === 'stream_event' && event.event.type === 'content_block_delta' && event.event.delta.type === cancelAt) {
              if (mode === 'return') break
              if (mode.startsWith('cancel') || measured) controller.abort()
            }
          }
        } finally { clearTimeout(deadline) }
        const usage = getUsageForModel(model)
        const assistants = rows.filter(row => row.type === 'assistant' && !row.isApiErrorMessage)
        const tail = assistants.at(-1)
        if (mode === 'pre-cancel') {
          assert.equal(engine.requests.length, before)
          assert.equal(usage, undefined)
        } else {
          assert.equal(engine.requests.length, before + 1)
          assert.ok(usage?.inputTokens > 0, `${dialect}/${mode}: consumed prompt enters the ledger`)
          assert.ok(usage.outputTokens > 0, `${dialect}/${mode}: delivered output enters the ledger`)
          if (measured) {
            assert.equal(usage.inputTokens, 75)
            assert.equal(usage.cacheReadInputTokens, 45)
            assert.equal(usage.outputTokens, 30)
            assert.equal(usage.costUSD, 0.0123)
            assert.equal(tail.message.usage.output_tokens_details.thinking_tokens, 7)
          } else if (mode === 'complete') {
            assert.equal(usage.inputTokens, 9)
            assert.equal(usage.cacheReadInputTokens, 3)
            assert.equal(usage.outputTokens, 7)
          } else assert.equal(usage.cacheReadInputTokens, 0, 'an estimate does not invent cached input')
          if (tail) {
            assert.equal(tail.message.usage.input_tokens, usage.inputTokens)
            assert.equal(tail.message.usage.output_tokens, usage.outputTokens)
          }
          if (mode.startsWith('cancel') || measured) {
            assert.ok(rows.every(row => !row.isApiErrorMessage))
            assert.ok(assistants.every(row => row.message.stop_reason === null))
          }
          if (mode === 'cut') assert.ok(rows.some(row => row.isApiErrorMessage))
        }
        console.log(`PASS ${dialect}/${mode}: usage settles exactly once with honest cache and completion state`)
      }
    } finally { await engine.close() }
  }
} finally {
  globalThis.fetch = fetchBefore
  f.close()
}
