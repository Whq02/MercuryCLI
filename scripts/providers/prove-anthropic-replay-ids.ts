import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { z } from 'zod/v4'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.2' }
const id = 'functions.EchoTool:0'
const requests: any[] = []
const sse = (o: any) => `${o.type ? `event: ${o.type}\n` : ''}data: ${JSON.stringify(o)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req: Request) {
  if (req.method === 'GET') return Response.json({ data: [], models: [] })
  const body: any = await req.json()
  if (new URL(req.url).pathname.endsWith('/chat/completions')) return new Response(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'EchoTool', arguments: '{"text":"hi"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 5 } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  requests.push(body)
  const blocks = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : [])
  const ids = blocks.flatMap((b: any) => b.type === 'tool_use' ? [b.id] : b.type === 'tool_result' ? [b.tool_use_id] : [])
  if (ids.some((value: string) => !/^[a-zA-Z0-9_-]+$/.test(value))) return Response.json({ error: { type: 'invalid_request_error', message: 'invalid tool ID' } }, { status: 400 })
  return new Response([
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ].map(sse).join(''), { headers: { 'content-type': 'text/event-stream' } })
} })
try {
  const base = `http://127.0.0.1:${server.port}`
  Object.assign(process.env, { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'fixture-key-not-real', MERCURY_COMPAT_BASE_URL: `${base}/compat/v1`, MERCURY_COMPAT_API_KEY: 'fixture-key-not-real', MERCURY_COMPAT_MODELS: 'qwen-max', MERCURY_COMPAT_LABEL: 'fixture', MERCURY_LOCAL_PROBE_TARGETS: 'none' })
  ;(await import('../../src/utils/config.ts')).enableConfigs()
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const tool = { name: 'EchoTool', description: async () => 'echo', prompt: async () => 'echo', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'EchoTool', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
  async function run(model: string, messages: any[]) {
    const out: any[] = []
    for await (const event of routedCallModel({ messages, tools: [tool], systemPrompt: asSystemPrompt(['sys']), thinkingConfig: { type: 'disabled' }, signal: AbortSignal.timeout(20000), options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } } as never)) if (event.type === 'assistant') out.push(event)
    return out
  }
  const user = createUserMessage({ content: 'call echo' })
  const first = await run('compat/qwen-max', [user])
  assert.equal(first.flatMap(m => m.message.content).find(b => b.type === 'tool_use')?.id, id)
  const result = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: 'hi' }] })
  const second = await run('claude-sonnet-5', [user, ...first, result])
  assert(second.some(m => !m.isApiErrorMessage && m.message.content.some((b: any) => b.text === 'ok')))
  const blocks = requests.at(-1).messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : [])
  assert.equal(blocks.find((b: any) => b.type === 'tool_use').id, blocks.find((b: any) => b.type === 'tool_result').tool_use_id)
  assert.equal(first.flatMap(m => m.message.content).find(b => b.type === 'tool_use')?.id, id)
  console.log('P14 cross-route IDs are paired on the Anthropic wire without changing stored history')
} finally { server.stop(true) }
const { normalizeAnthropicToolIds } = await import('../../src/services/providers/anthropic/toolIds.ts')
const { createHash } = await import('node:crypto')
const collision = `toolu_${createHash('sha256').update('a.b').digest('hex')}`
const originalIds = ['safe-id_0', 'a.b', 'a:b', collision]
const rows: any[] = [
  { role: 'assistant', content: originalIds.map(id => ({ type: 'tool_use', id, name: 'EchoTool', input: {} })) },
  { role: 'user', content: originalIds.map(id => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) },
]
const normalized: any[] = normalizeAnthropicToolIds(rows)
const mapped = normalized[0].content.map((b: any) => b.id)
assert.equal(new Set(mapped).size, originalIds.length)
assert.deepEqual(mapped, normalized[1].content.map((b: any) => b.tool_use_id))
assert.equal(mapped[0], originalIds[0])
assert.equal(mapped[3], collision)
assert.deepEqual(normalizeAnthropicToolIds(normalized), normalized)
assert.deepEqual(rows[0].content.map((b: any) => b.id), originalIds)
