import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import type { Message, AssistantMessage } from '../../src/types/message.js'
import type { Tool } from '../../src/Tool.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_TOOL_DEFER = '0'
delete process.env.MERCURY_EFFORT_LEVEL
const models = ['mistral-large-4', 'mistral-large-4-0']
const captures: Array<{ body: Record<string, any>; authorization: string | null }> = []
let retry = false
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request: Request) {
  if (new URL(request.url).pathname.endsWith('/models')) return Response.json({ data: models.map(id => ({ id, capabilities: { completion_chat: true, reasoning: true, function_calling: true } })) })
  const body = await request.json() as Record<string, any>
  captures.push({ body, authorization: request.headers.get('authorization') })
  if (retry) {
    retry = false
    return Response.json({ error: { message: 'Fixture temporary failure' } }, { status: 500 })
  }
  if (!['low', 'medium', 'high'].includes(body.reasoning_effort)) return Response.json({ error: { message: 'Unsupported reasoning effort', code: 'invalid_request' } }, { status: 400 })
  return new Response(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MISTRAL_API_KEY = 'proof-key-mistral-effort-not-real'
process.env.MERCURY_MISTRAL_API_BASE = `http://127.0.0.1:${server.port}/v1`
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.js')
const { buildMistralExtras } = await import('../../src/services/providers/mistral/mistralCallModel.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const { effortVocabularyFor } = await import('../../src/utils/model/capabilities.js')
const { resolveEffortTruth } = await import('../../src/utils/effort.js')
const tool = { name: 'FixtureRead', inputSchema: z.object({ path: z.string() }), prompt: async () => 'Read a fixture', description: async () => 'Read a fixture', isEnabled: () => true, isReadOnly: () => true, isConcurrencySafe: () => true } as unknown as Tool
async function turn(model: string, effort: string, messages: Message[], thinking = true) {
  const result: AssistantMessage[] = []
  for await (const item of routedCallModel({ messages, systemPrompt: ['Fixture system'], thinkingConfig: thinking ? { type: 'enabled', budgetTokens: 10000 } : { type: 'disabled' }, tools: [tool], signal: new AbortController().signal, options: { model, effortValue: effort, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false } } as never)) {
    if (item.type === 'assistant') result.push(item)
  }
  return result
}
try {
  for (const model of models) {
    for (const effort of ['low', 'medium', 'high']) {
      const view = effortVocabularyFor(model)
      assert.ok(view.kind === 'provider' && view.vocabulary.join(',') === 'low,medium,high')
      assert.equal(resolveEffortTruth(model, effort as never, { thinkingEnabled: true }).wire, effort)
      const before = captures.length
      retry = true
      const first = await turn(model, effort, [createUserMessage({ content: 'First request' })])
      assert.ok(first.length > 0 && first.every(item => !item.isApiErrorMessage))
      const continued = await turn(model, effort, [createUserMessage({ content: 'First request' }), ...first, createUserMessage({ content: 'Continue with the same effort' })])
      assert.ok(continued.length > 0 && continued.every(item => !item.isApiErrorMessage))
      const sent = captures.slice(before)
      assert.equal(sent.length, 3)
      for (const request of sent) {
        assert.equal(request.authorization, `Bearer ${process.env.MISTRAL_API_KEY}`)
        assert.equal(request.body.model, model)
        assert.equal(request.body.reasoning_effort, effort)
        assert.ok(request.body.tools.some((row: any) => row.function.name === 'FixtureRead'))
      }
      assert.deepEqual(sent[0]!.body, sent[1]!.body)
      assert.ok(JSON.stringify(sent[2]!.body.messages).includes('Continue with the same effort'))
      assert.ok(JSON.stringify(sent[2]!.body.messages).includes('answer'))
      console.log(`PASS ${model} ${effort}: selection, request, identical retry, continuation and tool roster`)
    }
    const off = await turn(model, 'high', [createUserMessage({ content: 'Thinking off' })], false)
    assert.ok(off.length > 0 && off.every(item => !item.isApiErrorMessage))
    assert.equal(captures.at(-1)!.body.reasoning_effort, 'low')
    const unsupported = await turn(model, 'max', [createUserMessage({ content: 'Keep my effort' })])
    assert.equal(captures.at(-1)!.body.reasoning_effort, 'max')
    assert.ok(unsupported.some(item => item.isApiErrorMessage))
    console.log(`PASS ${model}: off uses documented low; unsupported max is never downgraded`)
  }
  for (const model of ['mistral-small-2603', 'mistral-medium-3-5']) {
    const view = effortVocabularyFor(model)
    assert.ok(view.kind === 'provider' && view.vocabulary.join(',') === 'none,high')
    assert.equal(buildMistralExtras({ wireModel: model, effortValue: 'high', thinkingEnabled: false, maxOutputTokensOverride: undefined }).reasoning_effort, 'none')
  }
  assert.equal(buildMistralExtras({ wireModel: 'zai-glm-5-3', effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: undefined }).reasoning_effort, 'max')
  console.log('MISTRAL LARGE EFFORT GREEN')
} finally {
  server.stop(true)
  rmSync(proofHome, { recursive: true, force: true })
}
