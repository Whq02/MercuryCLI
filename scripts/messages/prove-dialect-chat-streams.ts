import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const { streamCompatChat } = await import(`${root}/src/models/roads/openaicompat/compatChatClient.ts`)
const { streamGeminiContent } = await import(`${root}/src/models/roads/gemini/geminiClient.ts`)
const { streamOllamaChat } = await import(`${root}/src/models/roads/local/ollamaChatTransport.ts`)
const { assembleZaiTurn } = await import(`${root}/src/models/roads/zai/zaiCodec.ts`)

const CHAT_STREAM_FIX_HINT = 'the stream event shape or the settled turn changed: streamCompatChat in src/models/roads/openaicompat/compatChatClient.ts, streamGeminiContent in src/models/roads/gemini/geminiClient.ts, streamOllamaChat in src/models/roads/local/ollamaChatTransport.ts, assembleZaiTurn in src/models/roads/zai/zaiCodec.ts; compare the printed diff with the fixture and restore the byte-pinned output'
const CHAT_CALL_FIX_HINT = 'compat tool fragments must emit the same blocks as Anthropic: compatChatCallModel in src/models/roads/openaicompat/compatChatCallModel.ts against queryModelWithStreaming in src/models/roads/anthropic/streamCore.ts'
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
  { type: 'tool-call-fragment', index: 0, id: 'fixture-call', name: 'Read', argumentsFragment: 'path":"/fixture"}' },
  { type: 'usage', usage: { inputTokens: 7, outputTokens: 5 } },
  { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls', toolCalls: [{ index: 0, id: 'fixture-call', name: 'Read', argumentsRaw: '{"file_path":"/fixture"}', arguments: { file_path: '/fixture' }, malformed: false }] },
], `compat chat stream events differ from the fixture; ${CHAT_STREAM_FIX_HINT}`)
assert.deepEqual(await assembleZaiTurn(asEvents(chatEvents)), expectedTurn, `compat chat events settle to a different turn; ${CHAT_STREAM_FIX_HINT}`)
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
}], `Gemini native turns differ from the fixture; ${CHAT_STREAM_FIX_HINT}`)
assert.deepEqual(await assembleZaiTurn(asEvents(geminiEvents)), { ...expectedTurn, usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 2, cachedInputTokens: 0 } }, `Gemini events settle to a different turn; ${CHAT_STREAM_FIX_HINT}`)
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
], `local stream events differ from the fixture; ${CHAT_STREAM_FIX_HINT}`)
assert.deepEqual(await assembleZaiTurn(asEvents(ollamaEvents)), expectedTurn, `local events settle to a different turn; ${CHAT_STREAM_FIX_HINT}`)
console.log('PASS: local stream events and settled content are byte-pinned')

const { z } = await import('zod/v4')
const { compatChatCallModel } = await import(root + '/src/models/roads/openaicompat/compatChatCallModel.ts')
const { queryModelWithStreaming } = await import(root + '/src/models/roads/anthropic/streamCore.ts')
const { getEmptyToolPermissionContext } = await import(root + '/src/tools/kit/tool.ts')
const { createUserMessage } = await import(root + '/src/engine/messages/messages.ts')
const { asSystemPrompt } = await import(root + '/src/engine/system-prompt/systemPromptType.ts')
const { enableConfigs } = await import(root + '/src/platform/config/globalConfig.ts')
enableConfigs()
process.env.ANTHROPIC_API_KEY = 'fixture-api-key'
const tool = { name: 'Read', prompt: async () => 'Read the fixture.', inputSchema: z.object({ file_path: z.string() }), inputJSONSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }, isEnabled: () => true, isReadOnly: () => true, isConcurrencySafe: () => true }
const params = {
  messages: [createUserMessage({ content: 'Read the fixture' })],
  systemPrompt: asSystemPrompt(['Only use the supplied fixture.']),
  thinkingConfig: { type: 'disabled' }, tools: [tool], signal: AbortSignal.timeout(30_000),
  options: { model: 'deepseek-v4-pro', querySource: 'sdk', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxRetries: 0 },
}
const toolBlocks = [
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture-call', name: 'Read', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'path":"/fixture"}' } },
  { type: 'content_block_stop', index: 0 },
]
const nativeFrames = [
  { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
  ...toolBlocks,
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]
const snapshot = async (stream: AsyncIterable<any>) => {
  const frames: unknown[] = []
  const tools: unknown[] = []
  for await (const item of stream) {
    if (item.type === 'stream_event' && item.event.type.startsWith('content_block_')) frames.push(JSON.parse(JSON.stringify(item.event)))
    if (item.type === 'assistant') tools.push(...item.message.content.filter((block: any) => block.type === 'tool_use'))
  }
  return { frames, tools }
}
const savedFetch = globalThis.fetch
globalThis.fetch = (async () => { throw new Error('only injected fixture requests are allowed') }) as typeof fetch
try {
  const compat = await snapshot(compatChatCallModel({
    lane: 'deepseek', providerLabel: 'fixture', credentialHint: 'fixture', resolveCredential: () => ({ apiKey: 'fixture' }),
    requestUrl: () => 'https://fixture.invalid/chat/completions', wireModelId: (id: string) => id, buildExtras: () => ({}),
    streamTransport: (options: any) => ({ events: streamCompatChat({ ...options, fetchImpl: fetchOf(sse(chatChunks.slice(2))) }) }),
  }, params as never))
  const anthropic = await snapshot(queryModelWithStreaming({ ...params, options: { ...params.options, model: 'claude-sonnet-5', fetchOverride: async () => new Response(nativeFrames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } }) } } as never))
  assert.deepEqual(compat.frames, toolBlocks, `compat content block frames differ from the Anthropic ones; ${CHAT_CALL_FIX_HINT}`)
  assert.deepEqual(anthropic.frames, toolBlocks, `Anthropic content block frames differ from the fixture; ${CHAT_CALL_FIX_HINT}`)
  assert.deepEqual(compat.tools, expectedTurn.toolUses.map(tool => ({ type: 'tool_use', ...tool })), `compat settled tool call differs from the fixture; ${CHAT_CALL_FIX_HINT}`)
  assert.deepEqual(anthropic.tools, compat.tools, `Anthropic settled tool call differs from the compat one; ${CHAT_CALL_FIX_HINT}`)
  console.log('PASS: compat tool fragments emit the same start, input JSON deltas, stop and settled call as Anthropic')
} finally {
  globalThis.fetch = savedFetch
}
