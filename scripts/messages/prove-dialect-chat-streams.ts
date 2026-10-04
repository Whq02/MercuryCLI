import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? new URL('../..', import.meta.url).pathname)
const { streamCompatChat } = await import(`${root}/src/services/providers/openaicompat/compatChatClient.ts`)
const { streamGeminiContent } = await import(`${root}/src/services/providers/gemini/geminiClient.ts`)
const { streamOllamaChat } = await import(`${root}/src/services/providers/local/ollamaChatTransport.ts`)
const { assembleZaiTurn } = await import(`${root}/src/services/providers/zai/zaiCodec.ts`)

const request = { model: 'fixture-model', messages: [{ role: 'user', content: 'fixture input' }] }
const sse = (chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const fetchOf = (response: Response) => (async (url: unknown) => {
  assert.equal(String(url).startsWith('https://fixture.invalid/'), true)
  return response
}) as typeof fetch
const collect = async (events: AsyncIterable<unknown>) => {
  const out: unknown[] = []
  for await (const event of events) out.push(event)
  return out
}
const asEvents = async function* (events: unknown[]) { yield* events }
const expectedTurn = {
  thinking: 'fixture thought',
  text: 'fixture answer',
  toolUses: [{ id: 'fixture-call', name: 'Read', input: { file_path: '/fixture' } }],
  malformedToolCalls: [],
  stopReason: 'tool_use',
  usage: { inputTokens: 7, outputTokens: 5 },
}

const chatChunks = [
  { choices: [{ delta: { reasoning_content: 'fixture thought' }, finish_reason: null }] },
  { choices: [{ delta: { content: 'fixture answer' }, finish_reason: null }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture-call', function: { name: 'Read', arguments: '{"file_' } }] }, finish_reason: null }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"/fixture"}' } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 5 } },
]
const chatEvents = await collect(streamCompatChat({ url: 'https://fixture.invalid/chat/completions', request, fetchImpl: fetchOf(sse(chatChunks)) }))
assert.deepEqual(chatEvents, [
  { type: 'reasoning-delta', text: 'fixture thought' },
  { type: 'text-delta', text: 'fixture answer' },
  { type: 'tool-call-fragment', index: 0, id: 'fixture-call', name: 'Read', argumentsFragment: '{"file_' },
  { type: 'tool-call-fragment', index: 0, argumentsFragment: 'path":"/fixture"}' },
  { type: 'usage', usage: { inputTokens: 7, outputTokens: 5 } },
  { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls', toolCalls: [{ index: 0, id: 'fixture-call', name: 'Read', argumentsRaw: '{"file_path":"/fixture"}', arguments: { file_path: '/fixture' }, malformed: false }] },
])
assert.deepEqual(await assembleZaiTurn(asEvents(chatEvents)), expectedTurn)
console.log('PASS: compatible chat stream events and settled content are byte-pinned')

const nativeTurns: unknown[] = []
const geminiEvents = await collect(streamGeminiContent({
  url: 'https://fixture.invalid/models/fixture:streamGenerateContent?alt=sse',
  request, messages: [], onTurn: (turn: unknown) => nativeTurns.push(turn),
  fetchImpl: fetchOf(sse([
    { candidates: [{ content: { parts: [{ text: 'fixture thought', thought: true }, { text: 'fixture answer', thoughtSignature: 'fixture-signature' }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { id: 'fixture-call', name: 'Read', args: { file_path: '/fixture' } }, thoughtSignature: 'fixture-tool-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 } },
  ])),
}))
assert.deepEqual(nativeTurns, [{
  model: 'fixture-model',
  parts: [
    { text: 'fixture thought', thought: true },
    { text: 'fixture answer', thoughtSignature: 'fixture-signature' },
    { functionCall: { name: 'Read', args: { file_path: '/fixture' }, id: 'fixture-call' }, thoughtSignature: 'fixture-tool-signature' },
  ],
  calls: [{ id: 'fixture-call', name: 'Read', nativeId: 'fixture-call' }],
  projection: '',
}])
assert.deepEqual(await assembleZaiTurn(asEvents(geminiEvents)), { ...expectedTurn, usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 2, cachedInputTokens: 0 } })
console.log('PASS: Gemini stream content and signatures are byte-pinned')

const ollamaRows = [
  { message: { thinking: 'fixture thought' } },
  { message: { content: 'fixture answer' } },
  { message: { tool_calls: [{ id: 'fixture-call', function: { name: 'Read', arguments: { file_path: '/fixture' } } }] } },
  { done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 5 },
]
const ollamaEvents = await collect(streamOllamaChat({
  url: 'https://fixture.invalid/api/chat', request,
  fetchImpl: fetchOf(new Response(ollamaRows.map(row => JSON.stringify(row)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } })),
}, {}))
assert.deepEqual(ollamaEvents, [
  { type: 'reasoning-delta', text: 'fixture thought' },
  { type: 'text-delta', text: 'fixture answer' },
  { type: 'tool-call-fragment', index: 0, id: 'fixture-call', name: 'Read', argumentsFragment: '{"file_path":"/fixture"}' },
  { type: 'usage', usage: { inputTokens: 7, outputTokens: 5 } },
  { type: 'finish', reason: 'tool_calls', rawReason: 'stop', toolCalls: [{ index: 0, id: 'fixture-call', name: 'Read', argumentsRaw: '{"file_path":"/fixture"}', arguments: { file_path: '/fixture' }, malformed: false }] },
])
assert.deepEqual(await assembleZaiTurn(asEvents(ollamaEvents)), expectedTurn)
console.log('PASS: local stream events and settled content are byte-pinned')
