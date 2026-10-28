import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { AssistantMessage, Message } from '../../src/types/message.js'
import type { Tool } from '../../src/Tool.js'

const home = mkdtempSync(join(tmpdir(), 'terra-shapes-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.OPENAI_API_KEY = 'fixture-key-not-real'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_EFFORT_LEVEL', 'MERCURY_WIRE_DUMP', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const model = 'gpt-6.1-terra'
const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: 'Checking the fixture.' }], content: [], encrypted_content: 'fixture-opaque-reasoning' }
const call = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'Echo', arguments: JSON.stringify({ value: 'fixture', optional: null }) }
const message = { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'OK' }] }
const usage = { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 100 }, output_tokens: 42, output_tokens_details: { reasoning_tokens: 30 } }
const captures: Array<Record<string, any>> = []
const sse = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model }] }))
    return
  }
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    captures.push(JSON.parse(Buffer.concat(chunks).toString()))
    const first = captures.length === 1
    const items = first ? [reasoning, call] : [message]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse({ type: 'response.created', response: { id: `resp_fixture_${captures.length}`, model } }))
    if (first) res.write(sse({ type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, delta: reasoning.summary[0]!.text }))
    for (const [output_index, item] of items.entries()) {
      res.write(sse({ type: 'response.output_item.added', output_index, item }))
      res.write(sse({ type: 'response.output_item.done', output_index, item }))
    }
    res.end(sse({ type: 'response.completed', response: { id: `resp_fixture_${captures.length}`, model, output: items, usage } }))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const base = `http://127.0.0.1:${address.port}/v1`
process.env.MERCURY_OPENAI_API_BASE = base
process.env.MERCURY_OPENAI_CHATGPT_BASE = base
process.env.MERCURY_OPENAI_AUTH_BASE = base

const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.js')
const { ResponsesStreamFold, mapOpenaiHttpFailure } = await import('../../src/services/providers/openai/openaiWire.js')
const { streamOpenaiResponses } = await import('../../src/services/providers/openai/openaiClient.js')
const { buildOpenaiResponsesRequest, decodeOpenaiTurnRecord } = await import('../../src/services/providers/openai/responsesBridge.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const tool = { name: 'Echo', inputSchema: z.object({ value: z.string(), optional: z.string().optional() }), prompt: async () => 'Echo the fixture value.', isEnabled: () => true, isReadOnly: () => true, isConcurrencySafe: () => true } as unknown as Tool
const options = { model, effortValue: 'max', querySource: 'sdk', ownerKey: 'terra-shapes', getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], mcpTools: [], isNonInteractiveSession: true, hasAppendSystemPrompt: false } as never
async function turn(messages: Message[]): Promise<AssistantMessage[]> {
  const settled: AssistantMessage[] = []
  for await (const event of openaiCallModel({ messages, systemPrompt: ['Use the fixture tool.'] as never, tools: [tool], thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, signal: new AbortController().signal, options })) if (event.type === 'assistant') settled.push(event)
  assert.ok(settled.length > 0)
  assert.ok(settled.every(row => !row.isApiErrorMessage))
  return settled
}
try {
  const firstUser = createUserMessage({ content: 'Echo the fixture value.' })
  const first = await turn([firstUser])
  const settled = first.at(-1)!
  assert.equal(settled.message.model, model)
  assert.equal(settled.message.stop_reason, 'tool_use')
  assert.deepEqual(first.flatMap(r => r.message.content).filter(b => b.type === 'tool_use').map(b => b.type === 'tool_use' ? b.input : undefined), [{ value: 'fixture' }])
  assert.deepEqual(settled.apexProviderTurn?.items, [reasoning, call])
  assert.deepEqual(settled.apexProviderTurn?.providerUsage, { inputTokensTotal: 1200, cachedInputTokens: 1024, cacheWriteInputTokens: 100, outputTokens: 42, reasoningOutputTokens: 30 })
  assert.deepEqual([settled.message.usage.input_tokens, settled.message.usage.cache_read_input_tokens, settled.message.usage.cache_creation_input_tokens, settled.message.usage.output_tokens], [76, 1024, 100, 42])
  assert.deepEqual(decodeOpenaiTurnRecord(JSON.parse(JSON.stringify(settled.apexProviderTurn)))?.items, [reasoning, call])
  const result = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: call.call_id, content: 'fixture' }] })
  const second = await turn([firstUser, ...first, result])
  assert.equal(second.at(-1)!.message.stop_reason, 'end_turn')
  assert.deepEqual(captures[1]!.input.slice(1), [reasoning, call, { type: 'function_call_output', call_id: call.call_id, output: 'fixture' }])
  assert.deepEqual(captures[0]!.tools, captures[1]!.tools)
  assert.equal(captures[0]!.prompt_cache_key, captures[1]!.prompt_cache_key)
  for (const body of captures) {
    assert.equal(body.model, model)
    assert.equal(body.reasoning.effort, 'max')
    assert.equal(body.store, false)
    assert.deepEqual(body.include, ['reasoning.encrypted_content'])
    assert.equal(body.previous_response_id, undefined)
  }
  for (const [detail, expected] of [['max_output_tokens', 'max_output_tokens'], ['content_filter', 'content_filter'], ['fixture-new-reason', 'other-incomplete']]) {
    const finish = new ResponsesStreamFold().fold({ type: 'response.incomplete', response: { incomplete_details: { reason: detail }, usage } }).find(e => e.type === 'finish')
    assert.equal(finish?.reason, expected)
    assert.equal(finish?.incompleteDetail, detail)
  }
  const wait = mapOpenaiHttpFailure(429, { error: { code: 'rate_limit_exceeded', message: 'Retry later.' } }, new Headers({ 'retry-after': '2', 'x-codex-secondary-used-percent': '100', 'x-codex-secondary-window-minutes': '10080' }))
  assert.equal(wait.retryAfterMs, 2000)
  assert.match(wait.message, /rate limited/)
  const request = buildOpenaiResponsesRequest({ model, messages: [{ role: 'user', content: 'Fixture.' }], reasoningEffort: 'max' })
  const cut = []
  for await (const event of streamOpenaiResponses({ baseUrl: base, headers: {}, request, fetchImpl: (async () => new Response(sse({ type: 'response.output_item.done', item: message }), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch })) cut.push(event)
  assert.ok(cut.some(e => e.type === 'stream-fault' && e.fault.code === 'no-terminal-event'))
  assert.ok(!cut.some(e => e.type === 'finish'))
  console.log('PASS Terra transcript shapes: reasoning replay, null optionals, ordered tool pairing, disjoint usage, max effort, stable prefix, stop reasons, Retry-After and missing terminal')
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
}
process.exit(0)
