import assert from 'node:assert/strict'
import { z } from 'zod/v4'
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
  const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
  for (const dialect of ['llamacpp', 'vllm', 'sglang', 'ollama']) {
    const engine = await startEngineRules(dialect)
    try {
      const model = `compat/fragment-${dialect}/${engine.model}`
      assert.equal(updateSettingsForSource('userSettings', {
        compatProvider: { [`fragment-${dialect}`]: { baseUrl: engine.baseUrl, dialect, models: [engine.model] } },
      }).error, null)
      const run = async () => {
        const out: any[] = []
        for await (const event of routedCallModel({ messages: [f.createUserMessage({ content: 'call the echo tool' })], tools: [tool], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: { type: 'enabled', budgetTokens: 8192 }, signal: AbortSignal.timeout(10000),
          options: { model, effortValue: 'max', ownerKey: `fragment-${dialect}`, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } } as never)) out.push(event)
        return out
      }
      engine.script([{ call: { name: 'FixtureEcho', arguments: '{"text":"hello"}' }, cut: true }])
      const rows = await run()
      const assistants = rows.filter(row => row.type === 'assistant')
      assert.equal(engine.requests.length, 1, `${dialect}: a cut after a tool fragment is not retried`)
      assert.ok(engine.requests.every(row => row.fault === undefined))
      assert.equal(assistants.length, 1, `${dialect}: no synthetic successful assistant for an uncompleted tool`)
      assert.equal(assistants[0].isApiErrorMessage, true)
      assert.equal(assistants[0].error, 'server_error')
      assert.doesNotMatch(JSON.stringify(assistants[0].message.content), /after partial content/)
      assert.equal(assistants.flatMap(row => row.message.content).filter((block: any) => block.type === 'tool_use').length, 0)
      const starts = rows.filter(row => row.event?.type === 'content_block_start')
      const stops = rows.filter(row => row.event?.type === 'content_block_stop')
      assert.equal(starts.length, 1)
      assert.deepEqual(stops.map(row => row.event.index), starts.map(row => row.event.index), `${dialect}: the painted fragment closes without executing`)
      const resumed = await run()
      assert.equal(engine.requests.length, 2)
      assert.ok(resumed.some(row => row.type === 'assistant' && !row.isApiErrorMessage && row.message.stop_reason === 'end_turn'))
      console.log(`PASS ${dialect}: cut tool fragment is a terminal fault, not completed content; explicit resume works`)
    } finally { await engine.close() }
  }
} finally {
  globalThis.fetch = fetchBefore
  f.close()
}
