import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { DIALECT_CONVERSATION } from './dialectFixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
const tip = resolve(new URL('../..', import.meta.url).pathname)
const base = process.argv[2] ? resolve(process.argv[2]) : tip
const frames = [
  { type: 'response.created', response: { id: 'fixture-response' } },
  { type: 'response.reasoning_summary_text.delta', delta: 'fixture thought' },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'fixture-reasoning', summary: [{ type: 'summary_text', text: 'fixture thought' }], encrypted_content: 'fixture-private' } },
  { type: 'response.output_item.added', item: { type: 'message', id: 'fixture-message', role: 'assistant', phase: 'commentary', content: [] } },
  { type: 'response.output_text.delta', delta: 'fixture answer' },
  { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'fixture answer' }] } },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fixture-item', call_id: 'fixture-call', name: 'Read', arguments: '' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fixture-item', delta: '{"file_path":"/fixture"}' },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 'fixture-item', call_id: 'fixture-call', name: 'Read' } },
  { type: 'response.completed', response: { id: 'fixture-response', usage: { input_tokens: 7, output_tokens: 5 } } },
]
async function responses(root: string) {
  const { ResponsesStreamFold } = await import(`${root}/src/services/providers/openai/openaiWire.ts`)
  const fold = new ResponsesStreamFold()
  const events = JSON.parse(JSON.stringify(frames)).flatMap((frame: unknown) => fold.fold(frame))
  const items = fold.settledItems()
  assert.equal(fold.finished, true)
  assert.deepEqual(items, [
    { type: 'reasoning', id: 'fixture-reasoning', summary: [{ type: 'summary_text', text: 'fixture thought' }], encrypted_content: 'fixture-private' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture answer' }], phase: 'commentary' },
    { type: 'function_call', call_id: 'fixture-call', name: 'Read', arguments: '{"file_path":"/fixture"}', id: 'fixture-item' },
  ])
  return { events, items }
}
async function anthropic(root: string) {
  const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
  enableConfigs()
  const state = await import(`${root}/src/bootstrap/state.ts`)
  state.setIsInteractive(false)
  const { queryModelWithStreaming } = await import(`${root}/src/services/providers/anthropic/streamCore.ts`)
  const { asSystemPrompt } = await import(`${root}/src/utils/systemPromptType.ts`)
  const { getEmptyToolPermissionContext } = await import(`${root}/src/Tool.ts`)
  const usage = { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 }
  const wireFrames = [
    { type: 'message_start', message: { id: 'fixture-anthropic-message', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'fixture thought' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signed-thinking' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'fixture answer' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage },
    { type: 'message_stop' },
  ]
  const fetchOverride = (async () => new Response(wireFrames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const rows: unknown[] = []
  for await (const item of queryModelWithStreaming({
    messages: DIALECT_CONVERSATION, systemPrompt: asSystemPrompt(['fixture system']), thinkingConfig: { type: 'disabled' }, tools: [], signal: new AbortController().signal,
    options: { model: 'claude-sonnet-5', querySource: 'sdk', isNonInteractiveSession: true, fetchOverride, maxRetries: 0, getToolPermissionContext: async () => getEmptyToolPermissionContext() } as never,
  })) {
    if (item.type === 'assistant') rows.push(item.message.content)
  }
  assert.deepEqual(rows, [[{ type: 'thinking', thinking: 'fixture thought', signature: 'fixture-signed-thinking' }], [{ type: 'text', text: 'fixture answer' }]])
  return rows
}
const old = { anthropic: await anthropic(base), openai: await responses(base) }
const next = { anthropic: await anthropic(tip), openai: await responses(tip) }
assert.equal(JSON.stringify(next), JSON.stringify(old))
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({ base: process.argv[2] ? '71641f1bd' : 'tip', old, new: next }, null, 2) + '\n')
console.log('PASS: Anthropic signed content blocks and Responses ordered reasoning, text and tool events are byte-identical to the selected base')
