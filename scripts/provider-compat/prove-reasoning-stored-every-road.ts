#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'reasoning-every-road-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MERCURY_OAUTH_TOKEN', 'CI', 'NODE_ENV']) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_MOONSHOT_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
process.env.MERCURY_MOONSHOT_CODING_BASE = 'http://127.0.0.1:1/coding/v1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail?: string): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const THOUGHT = 'The model thought this, verbatim: 2 + 2 → 4; keep the «guillemets» and the\nline break.'
const sse = (chunks: unknown[]): Response => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
const fetchOf = (response: Response): typeof fetch => (async () => response) as typeof fetch
const collect = async <T,>(events: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const event of events) out.push(event)
  return out
}
const reasoningOf = (events: ReadonlyArray<{ type: string; text?: string }>): string => events.filter(event => event.type === 'reasoning-delta').map(event => event.text ?? '').join('')
const request = { model: 'fixture-model', messages: [{ role: 'user' as const, content: 'fixture input' }] }

;(await import('../../src/utils/config.ts')).enableConfigs()
const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { streamGeminiContent } = await import('../../src/services/providers/gemini/geminiClient.ts')
const { streamOllamaChat } = await import('../../src/services/providers/local/ollamaChatTransport.ts')
const { streamZaiChat } = await import('../../src/services/providers/zai/zaiClient.ts')
const { ResponsesStreamFold } = await import('../../src/services/providers/openai/openaiWire.ts')
const { streamOpenaiResponses } = await import('../../src/services/providers/openai/openaiClient.ts')

section('§1 the shared chat runtime (Moonshot · DeepSeek · xAI · Meta · Mistral · Nous · MiniMax · Together · Cohere · Groq · Cerebras · Fireworks · Melious · OrcaRouter · Qwen · Hugging Face · OpenRouter chat · custom endpoints): every spelling of a reasoning block lands as reasoning deltas, verbatim, before the answer')
for (const [spelling, chunks] of [
  ['reasoning_content (Moonshot · DeepSeek · vLLM · Qwen · MiniMax · Fireworks)', [{ choices: [{ delta: { reasoning_content: THOUGHT } }] }, { choices: [{ delta: { content: 'answer' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]],
  ['reasoning (Groq · Cerebras · Together)', [{ choices: [{ delta: { reasoning: THOUGHT } }] }, { choices: [{ delta: { content: 'answer' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]],
  ['reasoning_details (OpenRouter chat)', [{ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: THOUGHT }] } }] }, { choices: [{ delta: { content: 'answer' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]],
  ['content thinking parts (Mistral)', [{ choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: THOUGHT }] }, { type: 'text', text: 'answer' }] } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]],
] as const) {
  const events = await collect(streamCompatChat({ url: 'https://fixture.invalid/chat/completions', request, fetchImpl: fetchOf(sse([...chunks])) }))
  const firstText = events.findIndex(event => event.type === 'text-delta')
  const lastReasoning = events.map(event => event.type).lastIndexOf('reasoning-delta')
  check(`${spelling}: the thought rides as reasoning deltas, byte for byte, before the text; the turn finishes`, reasoningOf(events) === THOUGHT && lastReasoning < firstText && events.some(event => event.type === 'finish'), JSON.stringify(events).slice(0, 400))
}

section('§2 Z.AI native chat (zai/ · GLM): reasoning_content lands as reasoning deltas')
{
  const events = await collect(streamZaiChat({ apiKey: 'fixture', request: { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }, fetchImpl: fetchOf(sse([{ choices: [{ delta: { reasoning_content: THOUGHT } }] }, { choices: [{ delta: { content: 'answer' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }])) } as never))
  check('GLM: the thought rides verbatim, then the text, then the finish', reasoningOf(events as never) === THOUGHT && events.some(event => (event as { type: string }).type === 'finish'), JSON.stringify(events).slice(0, 400))
}

section('§3 Gemini (API key · Google account · Google plan): a thought part lands as reasoning deltas; a signed thought with no text is stored as withheld, never invented')
{
  const turns: unknown[] = []
  const events = await collect(streamGeminiContent({ url: 'https://fixture.invalid/models/fixture:streamGenerateContent?alt=sse', request, messages: [], onTurn: (turn: unknown) => turns.push(turn), fetchImpl: fetchOf(sse([{ candidates: [{ content: { parts: [{ text: THOUGHT, thought: true }, { text: 'answer', thoughtSignature: 'sig-1' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 } }])) } as never))
  check('Gemini: the thought rides verbatim as reasoning deltas', reasoningOf(events as never) === THOUGHT, JSON.stringify(events).slice(0, 400))
  const withheld = await collect(streamGeminiContent({ url: 'https://fixture.invalid/models/fixture:streamGenerateContent?alt=sse', request, messages: [], onTurn: () => undefined, fetchImpl: fetchOf(sse([{ candidates: [{ content: { parts: [{ text: 'answer', thoughtSignature: 'sig-2' }] }, finishReason: 'STOP' }] }])) } as never))
  check('Gemini: a signature with no thought text is a withheld-reasoning event carrying the signature, and no reasoning text is invented', withheld.some(event => (event as { type: string; signature?: string }).type === 'reasoning-withheld' && (event as { signature?: string }).signature === 'sig-2') && reasoningOf(withheld as never) === '', JSON.stringify(withheld).slice(0, 300))
}

section('§4 local engines on Ollama\'s own /api/chat: message.thinking lands as reasoning deltas')
{
  const rows = [{ model: 'fixture-model', message: { role: 'assistant', content: '', thinking: THOUGHT }, done: false }, { model: 'fixture-model', message: { role: 'assistant', content: 'answer' }, done: false }, { model: 'fixture-model', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 5 }]
  const events = await collect(streamOllamaChat({ url: 'https://fixture.invalid/api/chat', request, fetchImpl: fetchOf(new Response(rows.map(row => JSON.stringify(row)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } })) } as never, {}))
  check('Ollama: the thought rides verbatim as reasoning deltas before the text', reasoningOf(events as never) === THOUGHT && events.some(event => (event as { type: string }).type === 'text-delta'), JSON.stringify(events).slice(0, 400))
}

section('§5 OpenAI Responses, the native road (api.openai.com · the ChatGPT sign-in): a reasoning item\'s summary AND its reasoning text both land (openai-node master, src/resources/responses/responses.ts, read 2026-10-28: response.reasoning_summary_text.delta, response.reasoning_text.delta/.done, a reasoning item\'s summary[] and content[] of reasoning_text)')
{
  const fold = new ResponsesStreamFold()
  const folded = (payload: unknown): Array<{ type: string; text?: string }> => fold.fold(payload) as never
  const summary = folded({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'summary words', sequence_number: 1 })
  check('a summary delta lands as a reasoning delta (as before)', reasoningOf(summary) === 'summary words', JSON.stringify(summary))
  const text = folded({ type: 'response.reasoning_text.delta', item_id: 'rs_1', output_index: 0, content_index: 0, delta: THOUGHT, sequence_number: 2 })
  check('a reasoning_text delta lands as a reasoning delta, verbatim', reasoningOf(text) === THOUGHT, JSON.stringify(text))
  const done = folded({ type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary words' }], content: [{ type: 'reasoning_text', text: THOUGHT }], encrypted_content: 'enc-1', status: 'completed' } })
  check('the done item of a streamed reasoning text emits nothing twice', reasoningOf(done) === '', JSON.stringify(done))
  const replay = fold.settledItems()[0] as { type: string; summary: unknown[]; content?: unknown[]; encrypted_content?: string }
  check('the replay record keeps the item as the provider gave it: summary, content and encrypted_content (store, never alter)', replay?.type === 'reasoning' && JSON.stringify(replay.summary) === JSON.stringify([{ type: 'summary_text', text: 'summary words' }]) && JSON.stringify(replay.content) === JSON.stringify([{ type: 'reasoning_text', text: THOUGHT }]) && replay.encrypted_content === 'enc-1', JSON.stringify(replay))
  const quiet = new ResponsesStreamFold()
  const doneOnly = quiet.fold({ type: 'response.output_item.done', output_index: 0, item: { id: 'rs_2', type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: THOUGHT }], encrypted_content: 'enc-2' } }) as never
  check('a reasoning item that arrives whole at its done event, with no delta before it, carries its text once', reasoningOf(doneOnly) === THOUGHT, JSON.stringify(doneOnly))
}
{
  const frames = [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_9', type: 'reasoning', summary: [] } },
    { type: 'response.reasoning_text.delta', item_id: 'rs_9', output_index: 0, content_index: 0, delta: THOUGHT, sequence_number: 1 },
    { type: 'response.reasoning_text.done', item_id: 'rs_9', output_index: 0, content_index: 0, text: THOUGHT, sequence_number: 2 },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_9', type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: THOUGHT }], encrypted_content: 'enc-9' } },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'answer' },
    { type: 'response.output_item.done', output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] } },
    { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-fixture', usage: { input_tokens: 7, output_tokens: 5 } } },
  ]
  const events = await collect(streamOpenaiResponses({ baseUrl: 'https://fixture.invalid', headers: { authorization: 'Bearer fixture' }, request: { model: 'gpt-fixture', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], store: false, stream: true } as never, fetchImpl: fetchOf(new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })) }))
  check('the client stream carries the thought once, verbatim, then the text, then the finish', reasoningOf(events as never) === THOUGHT && events.some(event => (event as { type: string; text?: string }).type === 'text-delta' && (event as { text?: string }).text === 'answer') && events.some(event => (event as { type: string }).type === 'finish'), JSON.stringify(events).slice(0, 500))
}

section('§6 the stored row: a reasoning block the runtime settles is an assistant thinking block with the provider\'s text, and the transcript codec writes it as a reasoning item of the same text')
{
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const spelled = String(url instanceof Request ? url.url : url)
    if (spelled === 'http://127.0.0.1:1/chat/completions') {
      return sse([{ id: 'c', object: 'chat.completion.chunk', model: 'kimi-k3.1-pro', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: THOUGHT } }] }, { id: 'c', object: 'chat.completion.chunk', model: 'kimi-k3.1-pro', choices: [{ index: 0, delta: { content: 'answer' } }] }, { id: 'c', object: 'chat.completion.chunk', model: 'kimi-k3.1-pro', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } }])
    }
    if (spelled.includes('/models')) return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fixture' } }), { status: 404, headers: { 'content-type': 'application/json' } })
    throw new Error(`unexpected request: ${spelled}`)
  }) as typeof fetch
  try {
    process.env.MOONSHOT_API_KEY = 'fixture-moonshot-key-not-real'
    const { moonshotCallModel } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
    const { createUserMessage } = await import('../../src/utils/messages.ts')
    const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
    const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
    const assistants: Array<{ message: { content: unknown } }> = []
    for await (const item of moonshotCallModel({
      messages: [createUserMessage({ content: 'say hi' })],
      systemPrompt: ['fixture system prompt'],
      thinkingConfig: { type: 'enabled', budget_tokens: 1024 },
      tools: [],
      signal: new AbortController().signal,
      options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model: 'kimi-k3.1-pro', isNonInteractiveSession: true, querySource: 'agent:builtin:test', agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'max' },
    } as never)) {
      const row = item as { type?: string; message?: { content: unknown }; isApiErrorMessage?: boolean }
      if (row.type === 'assistant' && row.message && row.isApiErrorMessage !== true) assistants.push(row as never)
    }
    const blocks = assistants.flatMap(row => (Array.isArray(row.message.content) ? (row.message.content as Array<{ type: string; thinking?: string; text?: string }>) : []))
    const thinking = blocks.find(block => block.type === 'thinking')
    check('the runtime settles one thinking block carrying the provider\'s reasoning verbatim, beside the text block', thinking?.thinking === THOUGHT && blocks.some(block => block.type === 'text' && block.text === 'answer'), JSON.stringify(blocks).slice(0, 400))
    const stored = assistants.find(row => Array.isArray(row.message.content) && (row.message.content as Array<{ type: string }>).some(block => block.type === 'thinking'))
    let ordinal = 0
    const record = stored ? (entryToRecord({ type: 'assistant', uuid: 'fixture-uuid', timestamp: new Date(0).toISOString(), message: { role: 'assistant', content: stored.message.content } } as never, { sessionId: 'fixture-session', nextOrdinal: () => ++ordinal, observedAt: new Date(0).toISOString(), source: { channel: 'interactive' } } as never) as { payload?: { content?: Array<{ kind: string; text?: string }> } }) : undefined
    const reasoning = record?.payload?.content?.find(block => block.kind === 'reasoning')
    check('the transcript codec writes that block as a reasoning item of the same text (what mercury tune exports)', reasoning?.text === THOUGHT, JSON.stringify(record).slice(0, 400))
  } finally {
    delete process.env.MOONSHOT_API_KEY
    globalThis.fetch = realFetch
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-reasoning-stored-every-road: ${checks} checks, ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
