import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { AssistantMessage, Message } from '../../src/types/message.js'
import type { Tool } from '../../src/Tool.js'

const home = mkdtempSync(join(tmpdir(), 'terra-prefix-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.OPENAI_API_KEY = 'fixture-key-not-real'
for (const key of ['NODE_ENV', 'MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_EFFORT_LEVEL', 'MERCURY_WIRE_DUMP']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const model = 'gpt-6.1-terra'
const definition = { type: 'function', name: 'WebFetch', description: 'Fetch a fixture.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, strict: true, defer_loading: true }
const searchCall = { type: 'tool_search_call', id: 'tsc_fixture', execution: 'server', call_id: null, status: 'completed', arguments: { paths: ['WebFetch'] } }
const searchOutput = { type: 'tool_search_output', id: 'tso_fixture', execution: 'server', call_id: null, status: 'completed', tools: [definition] }
const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [], content: [], encrypted_content: 'fixture-opaque' }
const toolCall = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'WebFetch', arguments: '{"value":"fixture"}' }
const captures: Record<string, any>[] = []
const sse = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model }] })); return }
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    captures.push(JSON.parse(Buffer.concat(chunks).toString()))
    const items = captures.length === 1 ? [reasoning, searchCall, searchOutput, toolCall] : [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'OK' }] }]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse({ type: 'response.created', response: { id: `resp_fixture_${captures.length}`, model } }))
    for (const item of items) res.write(sse({ type: 'response.output_item.done', item }))
    res.end(sse({ type: 'response.completed', response: { id: `resp_fixture_${captures.length}`, model, usage: { input_tokens: 2400, output_tokens: 40, input_tokens_details: { cached_tokens: 2048 }, output_tokens_details: { reasoning_tokens: 20 } } } }))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address(); assert.ok(address && typeof address === 'object')
const base = `http://127.0.0.1:${address.port}/v1`
process.env.MERCURY_OPENAI_API_BASE = base
process.env.MERCURY_OPENAI_CHATGPT_BASE = base
process.env.MERCURY_OPENAI_AUTH_BASE = base
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js'); enableConfigs()
const { recordGatewayProbe, openaiGatewayProbeKey } = await import('../../src/services/providers/deferralProbe.js')
recordGatewayProbe(openaiGatewayProbeKey(new URL(base).host), { verdict: 'openai-native', evidence: 'fixture pass-through', status: 200, probedAt: new Date().toISOString() })
const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.js')
const { decodeOpenaiTurnRecord, loadedToolNamesOf } = await import('../../src/services/providers/openai/responsesBridge.js')
const { planToolPayload, clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.js')
const { createUserMessage, createCompactBoundaryMessage } = await import('../../src/utils/messages.js')
const { extractDiscoveredToolNames } = await import('../../src/utils/toolSearch.js')
const makeTool = (name: string, shouldDefer = false): Tool => ({ name, shouldDefer, prompt: async () => 'Fetch a fixture.', description: async () => 'Fetch a fixture.', inputSchema: z.object({ value: z.string() }), isEnabled: () => true, isReadOnly: () => true, isConcurrencySafe: () => true } as unknown as Tool)
const tools = [makeTool('Read'), ToolSearchTool, makeTool('WebFetch', true), makeTool('Browser', true)] as Tool[]
const permission = getEmptyToolPermissionContext()
async function turn(messages: Message[], pool = tools): Promise<AssistantMessage[]> {
  const rows: AssistantMessage[] = []
  for await (const item of openaiCallModel({ messages, systemPrompt: ['Use the fixture tools.'] as never, tools: pool, thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, signal: new AbortController().signal, options: { model, effortValue: 'max', ownerKey: 'terra-prefix', agents: [], mcpTools: [], hasAppendSystemPrompt: false, isNonInteractiveSession: true, querySource: 'sdk', getToolPermissionContext: async () => permission } as never })) if (item.type === 'assistant') rows.push(item)
  assert.ok(rows.length > 0 && rows.every(row => !row.isApiErrorMessage))
  return rows
}
try {
  clearToolRosterLatches()
  const ask = createUserMessage({ content: 'Use WebFetch with the fixture value.' })
  const first = await turn([ask])
  assert.equal(first.at(-1)!.message.stop_reason, 'tool_use')
  const record = decodeOpenaiTurnRecord(JSON.parse(JSON.stringify(first.at(-1)!.apexProviderTurn)))
  assert.ok(record)
  assert.deepEqual(record.items, [reasoning, searchCall, searchOutput, toolCall])
  assert.deepEqual(loadedToolNamesOf(record.items), ['WebFetch'])
  const initial = captures[0]!
  assert.deepEqual(initial.tools.map((t: any) => t.name ?? t.type), ['Read', 'WebFetch', 'Browser', 'tool_search'])
  assert.ok(initial.tools.filter((t: any) => ['WebFetch', 'Browser'].includes(t.name)).every((t: any) => t.defer_loading === true))
  const history = [ask, ...first, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: toolCall.call_id, content: 'fixture' }] })]
  await turn(history, [...tools, makeTool('JoinedLater')])
  const next = captures[1]!
  assert.deepEqual(next.tools, initial.tools)
  assert.equal(next.instructions, initial.instructions)
  assert.equal(next.prompt_cache_key, initial.prompt_cache_key)
  assert.deepEqual(next.input.slice(0, initial.input.length), initial.input)
  assert.deepEqual(next.input.slice(initial.input.length, -1), record.items)
  assert.deepEqual([...extractDiscoveredToolNames(history)], ['WebFetch'])
  const boundary = createCompactBoundaryMessage('manual', 2400, history.at(-1)!.uuid)
  boundary.compactMetadata.preCompactDiscoveredTools = [...extractDiscoveredToolNames(history)].sort()
  const compacted: Message[] = JSON.parse(JSON.stringify([boundary, createUserMessage({ content: 'Synthetic compaction summary.' })]))
  assert.deepEqual([...extractDiscoveredToolNames(compacted)], ['WebFetch'])
  const plan = await planToolPayload({ model, tools, messages: compacted, latchKey: 'terra-prefix', agents: [], getToolPermissionContext: async () => permission })
  assert.equal(plan.wireForm, 'openai-native')
  assert.ok(!plan.deferredNames.has('WebFetch'))
  assert.ok(plan.deferredNames.has('Browser'))
  await turn(compacted)
  const after = captures[2]!
  assert.deepEqual(after.tools.map((t: any) => t.name ?? t.type), initial.tools.map((t: any) => t.name ?? t.type))
  assert.equal(after.tools.find((t: any) => t.name === 'WebFetch').defer_loading, undefined)
  assert.equal(after.tools.find((t: any) => t.name === 'Browser').defer_loading, true)
  assert.equal(after.prompt_cache_key, initial.prompt_cache_key)
  assert.ok(plan.conversationKey && !plan.conversationKey.includes(ask.uuid))
  assert.ok(after.input.every((i: any) => i.type !== 'reasoning'))
  assert.equal(after.reasoning.effort, 'max')
  console.log('PASS Terra native search and prefix: hosted load, frozen roster, ordered encrypted replay, new conversation at compaction, carried tool loaded in full and unopened tool still deferred')
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
}
process.exit(0)
