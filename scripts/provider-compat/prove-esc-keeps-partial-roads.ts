import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'esc-partial-roads-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_GEMINI_API_BASE = 'https://gemini.fixture.invalid/v1beta'
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'https://gemini.fixture.invalid/token'
process.env.OPENAI_API_KEY = 'fixture-openai-key'
process.env.MERCURY_OPENAI_API_BASE = 'https://openai.fixture.invalid/v1'
process.env.ZAI_API_KEY = 'fixture-zai-key'
process.env.MERCURY_ZAI_API_BASE = 'https://zai.fixture.invalid/v4'
process.env.DEEPSEEK_API_KEY = 'fixture-deepseek-key'
process.env.MERCURY_DEEPSEEK_API_BASE = 'https://deepseek.fixture.invalid'
process.env.MOONSHOT_API_KEY = 'fixture-moonshot-key'
process.env.MERCURY_MOONSHOT_API_BASE = 'https://moonshot.fixture.invalid/v1'
process.env.HF_TOKEN = 'fixture-hf-token'
process.env.MERCURY_HUGGINGFACE_API_BASE = 'https://huggingface.fixture.invalid/v1'
process.env.OPENROUTER_API_KEY = 'fixture-openrouter-key'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://openrouter.fixture.invalid/api/v1'
process.env.XAI_API_KEY = 'fixture-xai-key'
process.env.MERCURY_XAI_API_BASE = 'https://xai.fixture.invalid/v1'
process.env.MODEL_API_KEY = 'fixture-meta-key'
process.env.MERCURY_META_API_BASE = 'https://meta.fixture.invalid/v1'
process.env.MERCURY_COMPAT_BASE_URL = 'https://compat.fixture.invalid/v1'
process.env.MERCURY_COMPAT_MODELS = 'fixture-model'
process.env.MERCURY_COMPAT_LABEL = 'the fixture endpoint'
process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_MAX_RETRIES
delete process.env.MERCURY_DISABLE_NONSTREAMING_FALLBACK
for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_MODEL', 'MERCURY_COMPAT_API_KEY']) delete process.env[name]
const access = 'ya29.fixture-esc-access'
writeFileSync(join(home, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'oauth', client: { clientId: 'fixture-client' }, tokens: { accessToken: access, refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 3600000 } }))
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { geminiCallModel } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { zaiCallModel } = await import('../../src/services/providers/zai/zaiCallModel.ts')
const { deepseekLaneProfile } = await import('../../src/services/providers/deepseek/deepseekCallModel.ts')
const { openrouterLaneProfile } = await import('../../src/services/providers/openrouter/openrouterCallModel.ts')
const { xaiLaneProfile } = await import('../../src/services/providers/xai/xaiCallModel.ts')
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { compatCallModel } = await import('../../src/services/providers/openaicompat/compatCallModel.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
import type { Message } from '../../src/types/message.ts'
import type { CompatCallModelParams, CompatLaneProfile } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'

let checks = 0
let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

const SETTLED = 'The first paragraph settled before the cut.'
const PARTIAL = 'The second paragraph was still streaming when esc landed'
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
function params(modelId: string, signal: AbortSignal, extra: Record<string, unknown> = {}): CompatCallModelParams {
  return {
    messages: [user('Write two paragraphs.')], systemPrompt: asSystemPrompt(['Only answer the request.']), thinkingConfig: { type: 'disabled' }, tools: [], signal,
    options: { model: modelId, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64, ...extra } as never,
  }
}
type Item = { type: string; subtype?: string; isApiErrorMessage?: boolean; message?: { content: Array<{ type: string; text?: string }> }; event?: { type?: string; delta?: { type?: string; text?: string } } }
const encoder = new TextEncoder()
const hanging = (chunks: string[], contentType: string, signal: AbortSignal | null | undefined): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(sink) {
      for (const chunk of chunks) sink.enqueue(encoder.encode(chunk))
      const cut = (): void => sink.error(new DOMException('The operation was aborted.', 'AbortError'))
      if (signal?.aborted) cut()
      else signal?.addEventListener('abort', cut, { once: true })
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}
const sseBody = (chunks: unknown[]): string => chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
const ndjsonBody = (rows: unknown[]): string => rows.map(row => `${JSON.stringify(row)}\n`).join('')
let hits = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  if (url.endsWith('/token')) return Response.json({ access_token: access, expires_in: 3600 })
  const chat = url.includes('/chat/completions')
  const responses = url.endsWith('/responses')
  const ollama = url.endsWith('/api/chat')
  const gemini = url.includes(':streamGenerateContent')
  if (method !== 'POST' || !(chat || responses || ollama || gemini)) return Response.json({ data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] })
  hits++
  const signal = init?.signal
  if (responses) return hanging([sseBody([{ type: 'response.created', response: { id: 'resp_fixture' } }, { type: 'response.output_text.delta', delta: SETTLED }, { type: 'response.output_text.delta', delta: ' ' }, { type: 'response.output_text.delta', delta: PARTIAL }])], 'text/event-stream', signal)
  if (chat) return hanging([sseBody([{ choices: [{ delta: { role: 'assistant', content: SETTLED }, finish_reason: null }] }, { choices: [{ delta: { content: ' ' }, finish_reason: null }] }, { choices: [{ delta: { content: PARTIAL }, finish_reason: null }] }])], 'text/event-stream', signal)
  if (ollama) return hanging([ndjsonBody([{ model: 'llama-fixture', message: { role: 'assistant', content: SETTLED }, done: false }, { model: 'llama-fixture', message: { role: 'assistant', content: ' ' }, done: false }, { model: 'llama-fixture', message: { role: 'assistant', content: PARTIAL }, done: false }])], 'application/x-ndjson', signal)
  return hanging([sseBody([{ candidates: [{ content: { role: 'model', parts: [{ text: SETTLED }] } }] }, { candidates: [{ content: { role: 'model', parts: [{ text: ' ' }] } }] }, { candidates: [{ content: { role: 'model', parts: [{ text: PARTIAL }] } }] }])], 'text/event-stream', signal)
}) as typeof fetch

type Road = { name: string; call: (signal: AbortSignal) => AsyncGenerator<unknown> }
const localProfile: CompatLaneProfile = localLaneProfileFor({ id: 'llama-fixture', server: 'ollama', baseUrl: 'https://local.fixture.invalid/v1' })
const roads: Road[] = [
  { name: 'openai', call: signal => openaiCallModel(params('gpt-5.6-sol', signal) as never) as AsyncGenerator<unknown> },
  { name: 'zai', call: signal => zaiCallModel(params('glm-5.2', signal) as never) as AsyncGenerator<unknown> },
  { name: 'deepseek', call: signal => compatChatCallModel(deepseekLaneProfile, params('deepseek-chat', signal)) },
  { name: 'openrouter', call: signal => compatChatCallModel(openrouterLaneProfile, params('openrouter/vendor/model', signal)) },
  { name: 'xai', call: signal => compatChatCallModel(xaiLaneProfile, params('grok-5', signal)) },
  { name: 'gemini', call: signal => geminiCallModel(params('gemini-3.5-flash', signal)) },
  { name: 'local', call: signal => compatChatCallModel(localProfile, params('local/llama-fixture', signal)) },
  { name: 'openai-compat', call: signal => compatCallModel(params('compat/fixture-model', signal)) },
]

const HOME_MODEL = 'claude-fable-5-1'
const homeSse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const homeUsage = { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }
function anthropicRoad(signal: AbortSignal): AsyncGenerator<unknown> {
  const fetchOverride = (async (_input: unknown, init?: RequestInit) => {
    hits++
    return hanging([
      homeSse('message_start', { type: 'message_start', message: { id: 'msg_fixture_home', type: 'message', role: 'assistant', model: HOME_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: homeUsage } }),
      homeSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      homeSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: SETTLED } }),
      homeSse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      homeSse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      homeSse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: PARTIAL } }),
    ], 'text/event-stream', init?.signal)
  }) as unknown as typeof fetch
  return queryModelWithStreaming({
    messages: [user('Write two paragraphs.')],
    systemPrompt: asSystemPrompt(['Only answer the request.']),
    thinkingConfig: { type: 'disabled' } as never,
    tools: [],
    signal,
    options: { model: HOME_MODEL, querySource: 'main_thread', isNonInteractiveSession: true, fetchOverride: fetchOverride as never, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64, skipCacheWrite: true } as never,
  }) as AsyncGenerator<unknown>
}

const textOf = (item: Item): string => item.message?.content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('') ?? ''
async function escMidStream(road: Road): Promise<{ items: Item[]; threw: unknown; escAt: number }> {
  hits = 0
  const controller = new AbortController()
  const items: Item[] = []
  let escAt = -1
  let threw: unknown
  const generator = road.call(controller.signal)
  const guard = setTimeout(() => { if (escAt === -1) { escAt = -2; controller.abort() } }, 15_000)
  try {
    for await (const raw of generator) {
      const item = raw as Item
      items.push(item)
      if (process.env.ESC_TRACE === '1') console.log(`   · ${item.type}${item.event?.type ? ` ${item.event.type}` : ''}${item.type === 'assistant' ? ` ${JSON.stringify(textOf(item)).slice(0, 80)}` : ''}`)
      const delta = item.type === 'stream_event' ? item.event?.delta : undefined
      const streamedPartial = delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.includes(PARTIAL)
      if (streamedPartial && escAt === -1) {
        escAt = items.length
        controller.abort()
      }
    }
  } catch (error) {
    threw = error
  } finally {
    clearTimeout(guard)
  }
  return { items, threw, escAt }
}

try {
  const only = process.env.ESC_ROAD
  for (const road of [...roads, { name: 'anthropic', call: anthropicRoad }].filter(road => only === undefined || road.name === only)) {
    console.log(`── ${road.name}`)
    const run = await escMidStream(road)
    const assistant = run.items.filter(item => item.type === 'assistant' && item.isApiErrorMessage !== true)
    const texts = assistant.map(textOf)
    const red = run.items.filter(item => item.type === 'assistant' && item.isApiErrorMessage === true)
    check(`${road.name}: the operator watched the second paragraph stream before esc landed`, run.escAt > 0, `${run.items.length} items, no text delta carried the partial`)
    check(`${road.name}: the words streamed before the cut are minted as assistant blocks — the settled paragraph and the one still streaming`, texts.some(text => text.includes(SETTLED)) && texts.some(text => text.includes(PARTIAL)), JSON.stringify(texts))
    check(`${road.name}: the partial block is minted after esc, from the words already on the wire — nothing is re-requested`, hits === 1 && assistant.length > 0 && run.items.slice(run.escAt).some(item => item.type === 'assistant' && textOf(item).includes(PARTIAL)), `${hits} request(s) · after esc: ${JSON.stringify(run.items.slice(run.escAt).filter(item => item.type === 'assistant').map(textOf))}`)
    check(`${road.name}: the stream ends quietly — no red line, no throw (the turn machine paints the interruption row)`, red.length === 0 && run.threw === undefined, `${red.length} red · ${run.threw === undefined ? 'no throw' : String(run.threw)}`)
  }
} finally {
  globalThis.fetch = realFetch
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-esc-keeps-partial-roads: ALL LAWS HOLD' : `prove-esc-keeps-partial-roads: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
