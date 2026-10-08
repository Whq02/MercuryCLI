#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type Server } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = mkdtempSync(join(tmpdir(), 'effort-stamp-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_HOME = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
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
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '5000'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_MAX_RETRIES
delete process.env.MERCURY_MODEL
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.NODE_ENV
for (const name of ['MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_COMPAT_API_KEY', 'MERCURY_BUSY_RETRY_SCALE']) delete process.env[name]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const sameStamp = (a: unknown, b: unknown): boolean => j(a) === j(b)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)

const stampModule = await import('../../src/utils/effortStamp.ts').catch(() => null)
const record = await import('../../src/fabric/record.ts')
const { entryToRecord, recordToEntry } = await import('../../src/fabric/entryCodec.ts')
const { validateRecord } = await import('../../src/fabric/validate.ts')
const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.ts')
const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { __resetOpenaiCatalogueForTest } = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const { zaiCallModel } = await import('../../src/services/providers/zai/zaiCallModel.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { moonshotLaneProfile } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
const { deepseekLaneProfile } = await import('../../src/services/providers/deepseek/deepseekCallModel.ts')
const { huggingfaceLaneProfile } = await import('../../src/services/providers/huggingface/huggingfaceCallModel.ts')
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const discovery = await import('../../src/services/providers/local/localDiscovery.ts')
const windows = await import('../../src/services/providers/local/localWindow.ts')
const { createUserMessage, createAssistantMessage, createAssistantAPIErrorMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { setSubModelEffort, subModelDispatchEffort } = await import('../../src/utils/model/subModelSlots.ts')
const { recordTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage/writer.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { jsonlConciseRows } = await import('../../src/services/resources/adapters/transcript.ts')
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'

type Stamp = { asked: string; applied: string; wire: string }
type Row = AssistantMessage & { effort?: Stamp }
const stampOf = (m: Row | undefined): Stamp | undefined => m?.effort
const realRows = (items: unknown[]): Row[] => items.filter(i => (i as Row).type === 'assistant' && (i as Row).isApiErrorMessage !== true) as Row[]
const errorRows = (items: unknown[]): Row[] => items.filter(i => (i as Row).type === 'assistant' && (i as Row).isApiErrorMessage === true) as Row[]

const NONE: Stamp = { asked: 'none', applied: 'none', wire: 'none' }

section('§A the stamp vocabulary and the records law (schemaVersion unchanged; the field is additive)')
{
  check('the stamp owner src/utils/effortStamp.ts exists on this tree', stampModule !== null, 'the module is absent — every request record on this tree rides without its effort')
  if (stampModule !== null) {
    const sent = stampModule.effortStampOf('max', { kind: 'sent', parameter: 'output_config.effort', value: 'max' })
    check('a word on the wire: {asked, applied: the word, wire: parameter=value}', sameStamp(sent, { asked: 'max', applied: 'max', wire: 'output_config.effort=max' }), j(sent))
    const off = stampModule.effortStampOf('high', { kind: 'sent', parameter: 'think', value: false, applied: stampModule.EFFORT_STAMP_THINKING_OFF })
    check("thinking off on the wire: applied says 'thinking off', the wire spells the parameter and value", sameStamp(off, { asked: 'high', applied: 'thinking off', wire: 'think=false' }), j(off))
    const omitted = stampModule.effortStampOf(undefined, { kind: 'omitted' })
    check("nothing asked, nothing sent: every word is 'none' (never absent)", sameStamp(omitted, NONE), j(omitted))
    const unsupported = stampModule.effortStampOf('xhigh', { kind: 'unsupported' })
    check("a model with no effort dial: applied says 'not supported by this model', wire 'none'", sameStamp(unsupported, { asked: 'xhigh', applied: 'not supported by this model', wire: 'none' }), j(unsupported))
    check('the one line every reader prints', stampModule.effortStampLine(sent) === 'effort asked max · applied max · wire output_config.effort=max' && stampModule.effortStampLine(undefined) === 'effort unstamped', stampModule.effortStampLine(sent))
  }
  const wire = await import('../../src/services/providers/openaicompat/compatWire.ts').catch(() => null) as (typeof import('../../src/services/providers/openaicompat/compatWire.ts') & { compatEffortWireFact?: unknown }) | null
  const readFact = wire !== null && typeof wire.compatEffortWireFact === 'function' ? (wire.compatEffortWireFact as (extra: Record<string, unknown>, args: { thinkingGated: boolean; thinkingEnabled: boolean; supported: boolean }) => unknown) : undefined
  check('the compat runtime reads its wire fact off the composed extras through one pure reader (compatWire.compatEffortWireFact)', readFact !== undefined)
  if (readFact !== undefined && wire !== null) {
    const on = { wireModel: 'x', effortValue: 'high', thinkingEnabled: true, maxOutputTokensOverride: undefined }
    const off = { ...on, thinkingEnabled: false }
    check('Kimi extras → reasoning_effort=high, the word (the dial is not thinking-gated, so thinking off changes nothing)', sameStamp(readFact(wire.buildMoonshotExtras({ ...off, wireModel: 'kimi-k3' }), { thinkingGated: false, thinkingEnabled: false, supported: true }), { kind: 'sent', parameter: 'reasoning_effort', value: 'high' }))
    check("OpenRouter extras with thinking off → reasoning.effort=none spelled on the wire, applied 'thinking off'", sameStamp(readFact(wire.buildOpenrouterExtras({ ...off, vocabulary: wire.OPENROUTER_REASONING_EFFORTS }), { thinkingGated: true, thinkingEnabled: false, supported: true }), { kind: 'sent', parameter: 'reasoning.effort', value: 'none', applied: 'thinking off' }))
    check('OpenRouter extras with thinking on → reasoning.effort=high, the word', sameStamp(readFact(wire.buildOpenrouterExtras({ ...on, vocabulary: wire.OPENROUTER_REASONING_EFFORTS }), { thinkingGated: true, thinkingEnabled: true, supported: true }), { kind: 'sent', parameter: 'reasoning.effort', value: 'high' }))
    check("Gemini extras with thinking off → reasoning_effort=low on the wire, applied 'thinking off'", sameStamp(readFact(wire.buildGeminiExtras({ ...off, acceptsEffort: true }), { thinkingGated: true, thinkingEnabled: false, supported: true }), { kind: 'sent', parameter: 'reasoning_effort', value: 'low', applied: 'thinking off' }))
    check("DeepSeek extras with thinking off → thinking.type=disabled, applied 'thinking off'", sameStamp(readFact(wire.buildDeepseekExtras({ ...off, wireModel: 'deepseek-chat' }), { thinkingGated: true, thinkingEnabled: false, supported: true }), { kind: 'sent', parameter: 'thinking.type', value: 'disabled', applied: 'thinking off' }))
    check('the compat slot sends no dial → unsupported when the model takes none, omitted when it does', sameStamp(readFact(wire.buildCompatSlotExtras(on), { thinkingGated: false, thinkingEnabled: true, supported: false }), { kind: 'unsupported' }) && sameStamp(readFact(wire.buildCompatSlotExtras(on), { thinkingGated: false, thinkingEnabled: true, supported: true }), { kind: 'omitted' }))
  }
  check('SCHEMA_VERSION stays 1 — an additive optional meta field needs no bump', record.SCHEMA_VERSION === 1, String(record.SCHEMA_VERSION))
  const ctx = (() => {
    let n = 0
    return { sessionId: '00000000-aaaa-4000-8000-000000000001' as never, nextOrdinal: () => ordinalOf(++n) as never, observedAt: '2026-08-03T00:00:00.000Z', source: { channel: 'sdk' } as const }
  })()
  const stamp: Stamp = { asked: 'max', applied: 'max', wire: 'output_config.effort=max' }
  const entry = {
    uuid: '00000000-bbbb-4000-8000-000000000002',
    timestamp: '2026-08-01T10:00:00.000Z',
    parentUuid: null,
    isSidechain: false,
    sessionId: '00000000-aaaa-4000-8000-000000000001',
    type: 'assistant',
    requestId: 'req_1',
    effort: stamp,
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'hi', citations: null }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }
  const encoded = entryToRecord(entry, ctx as never)
  const meta = (encoded.payload as { meta?: { effort?: unknown } }).meta
  check('the codec lifts the message stamp to payload.meta.effort on the output record', encoded.payload.kind === 'output' && sameStamp(meta?.effort, stamp), j(encoded.payload))
  check('the record does not also carry the stamp in annotations (one home)', !('effort' in (encoded.annotations ?? {})), j(encoded.annotations))
  const validated = validateRecord(JSON.parse(JSON.stringify(encoded)))
  check('the record validates under the schema (meta is an open field bag — additive by law)', validated.ok, validated.ok ? '' : j(validated.issues))
  if (validated.ok) {
    const back = recordToEntry(validated.record) as { effort?: unknown }
    check('the projection restores entry.effort byte-for-byte (the lossless codec bar holds)', sameStamp(back.effort, stamp), j(back.effort))
  }
  const bare = entryToRecord({ ...entry, effort: undefined }, ctx as never)
  check('an entry without a stamp encodes without meta.effort (the codec invents nothing; the writer stamps)', (bare.payload as { meta?: { effort?: unknown } }).meta?.effort === undefined)
}

section('§B the writer: every assistant record carries the field — a synthetic row says none, never absent')
{
  const unstamped = createAssistantMessage({ content: 'a literal-built row with no stamp' }) as Row
  delete unstamped.effort
  const refusal = createAssistantAPIErrorMessage({ content: 'API Error: refused before dispatch' }) as Row
  delete refusal.effort
  await recordTranscript([createUserMessage({ content: 'hello' }), unstamped, refusal] as never)
  await flushSessionStorage()
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.jsonl')) files.push(p)
    }
  }
  walk(HOME)
  const sessionFile = files.find(f => f.includes(getSessionId()))
  check('the session file materialized in the scratch home', sessionFile !== undefined, files.join(', '))
  const outputs: Array<{ recordId: string; meta?: { effort?: unknown } }> = []
  for (const line of sessionFile ? readFileSync(sessionFile, 'utf8').split('\n') : []) {
    if (!line.includes('"kind":"output"')) continue
    try {
      const rec = JSON.parse(line) as { recordId: string; payload: { kind: string; meta?: { effort?: unknown } } }
      if (rec.payload.kind === 'output') outputs.push({ recordId: rec.recordId, meta: rec.payload.meta })
    } catch {
      continue
    }
  }
  check('two output records reached the file', outputs.length === 2, `${outputs.length} output records`)
  check("the unstamped row's record carries payload.meta.effort = none/none/none", sameStamp(outputs.find(o => o.recordId === unstamped.uuid)?.meta?.effort, NONE), j(outputs.find(o => o.recordId === unstamped.uuid)?.meta))
  check("the API-error row's record carries payload.meta.effort = none/none/none (nothing rode the wire)", sameStamp(outputs.find(o => o.recordId === refusal.uuid)?.meta?.effort, NONE), j(outputs.find(o => o.recordId === refusal.uuid)?.meta))
  if (sessionFile !== undefined) {
    const rows = jsonlConciseRows(sessionFile)
    check('the transcript adapter reads the record format and shows the stamp on the assistant row', rows.some(r => r.startsWith('assistant:') && r.includes('effort asked none · applied none · wire none')), rows.join(' | ').slice(0, 400))
  }
}

const anthropicFrames = (model: string): string[] => {
  const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
  const usage = { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
  return [
    sse('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the fixture answer' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...usage, output_tokens: 40 } }),
    sse('message_stop', { type: 'message_stop' }),
  ]
}
type WireCapture = { bodies: Record<string, unknown>[] }
function anthropicFixtureFetch(model: string, wire: WireCapture): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    wire.bodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {})
    const encoder = new TextEncoder()
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of anthropicFrames(model)) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    })
    return new Response(readable, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture_stream' } })
  }) as unknown as typeof fetch
}
async function driveAnthropic(model: string, effortValue: string | undefined, thinking: 'adaptive' | 'disabled', extra: Record<string, unknown> = {}): Promise<{ rows: Row[]; body: Record<string, unknown> | undefined; thrown: string | null }> {
  const wire: WireCapture = { bodies: [] }
  const controller = new AbortController()
  const rows: Row[] = []
  let thrown: string | null = null
  const deadline = setTimeout(() => controller.abort(), 30_000)
  try {
    for await (const ev of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'effort-stamp fixture prompt' })],
      systemPrompt: asSystemPrompt(['You are the effort-stamp fixture.']),
      thinkingConfig: (thinking === 'adaptive' ? { type: 'adaptive' } : { type: 'disabled' }) as never,
      tools: [],
      signal: controller.signal,
      options: {
        model,
        querySource: 'sdk',
        isNonInteractiveSession: true,
        fetchOverride: anthropicFixtureFetch(model, wire) as never,
        maxRetries: 0,
        ...(effortValue !== undefined ? { effortValue } : {}),
        getToolPermissionContext: async () => ({ mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} }) as never,
        ...extra,
      } as never,
    })) {
      if ((ev as Row).type === 'assistant') rows.push(ev as Row)
    }
  } catch (e) {
    thrown = String(e)
  }
  clearTimeout(deadline)
  return { rows, body: wire.bodies.at(-1), thrown }
}

section('§C the Anthropic road: adaptive thinking, effort max and high — the record carries the exact output_config.effort')
{
  const max = await driveAnthropic('claude-opus-5-5', 'max', 'adaptive')
  const maxBody = (max.body?.output_config as { effort?: string } | undefined)?.effort
  check('the request rode with output_config.effort = max (the wire truth beside the stamp)', maxBody === 'max', `${j(max.body?.output_config)} ${max.thrown ?? ''}`)
  check('the settled row stamps {asked max, applied max, wire output_config.effort=max}', sameStamp(stampOf(max.rows.at(-1)), { asked: 'max', applied: 'max', wire: 'output_config.effort=max' }), `effort ${j(stampOf(max.rows.at(-1)))} on ${max.rows.length} row(s) ${max.thrown ?? ''}`)
  const high = await driveAnthropic('claude-fable-5-1', 'high', 'adaptive')
  check('effort high on Fable 5.1 rides as output_config.effort = high', (high.body?.output_config as { effort?: string } | undefined)?.effort === 'high', j(high.body?.output_config))
  check('the settled row stamps {asked high, applied high, wire output_config.effort=high}', sameStamp(stampOf(high.rows.at(-1)), { asked: 'high', applied: 'high', wire: 'output_config.effort=high' }), j(stampOf(high.rows.at(-1))))
  const fold = await driveAnthropic('claude-fable-5-1', 'high', 'adaptive', { querySource: 'compact' })
  const foldRow = (fold.body?.messages as Array<{ role?: string; output_config?: { effort?: string } }> | undefined)?.find(m => m.role === 'system' && m.output_config?.effort !== undefined)
  check('a fold stamps the session effort without a message-level override', foldRow === undefined && sameStamp(stampOf(fold.rows.at(-1)), { asked: 'high', applied: 'high', wire: 'output_config.effort=high' }), `row ${j(foldRow)} stamp ${j(stampOf(fold.rows.at(-1)))}`)
  const unasked = await driveAnthropic('claude-opus-4-5-20250101', undefined, 'disabled')
  const unaskedWord = (unasked.body?.output_config as { effort?: string } | undefined)?.effort
  check("nothing asked on a ladder model: asked says 'none' and applied names the default word the wire carried", unaskedWord !== undefined && sameStamp(stampOf(unasked.rows.at(-1)), { asked: 'none', applied: unaskedWord, wire: `output_config.effort=${unaskedWord}` }), `stamp ${j(stampOf(unasked.rows.at(-1)))} output_config ${j(unasked.body?.output_config)}`)
  const none = await driveAnthropic('claude-haiku-4-5-20251001', 'high', 'disabled')
  check("a legacy first-party id with no effort dial: applied says 'not supported by this model', wire none, and the body carries no output_config.effort", sameStamp(stampOf(none.rows.at(-1)), { asked: 'high', applied: 'not supported by this model', wire: 'none' }) && (none.body?.output_config as { effort?: string } | undefined)?.effort === undefined, `stamp ${j(stampOf(none.rows.at(-1)))} output_config ${j(none.body?.output_config)}`)
}

section('§D a sub-model call (the console seat) stamps the word its own dial dispatched')
{
  const set = setSubModelEffort('console', 'low')
  const dispatch = subModelDispatchEffort('console', 'claude-fable-5-1')
  check("the console's dial is low and dispatches low", set.ok && dispatch.effortValue === 'low', j({ set, dispatch }))
  const console_ = await driveAnthropic('claude-fable-5-1', dispatch.effortValue, 'disabled', { querySource: 'console_ask' })
  check('the console ask rode output_config.effort = low', (console_.body?.output_config as { effort?: string } | undefined)?.effort === 'low', j(console_.body?.output_config))
  check("the console ask's record stamps {asked low, applied low, wire output_config.effort=low}", sameStamp(stampOf(console_.rows.at(-1)), { asked: 'low', applied: 'low', wire: 'output_config.effort=low' }), j(stampOf(console_.rows.at(-1))))
}

const user = (content: string): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
function compatParams(modelId: string, effortValue: string | undefined, thinking: boolean): CompatCallModelParams {
  return {
    messages: [user('Say hello.')],
    systemPrompt: asSystemPrompt(['Only answer the request.']),
    thinkingConfig: (thinking ? { type: 'enabled', budget_tokens: 1024 } : { type: 'disabled' }) as never,
    tools: [],
    signal: new AbortController().signal,
    options: { model: modelId, querySource: 'agent:builtin:mercury-crew', agentId: 'a-effort-fixture', onWait: () => {}, isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], ...(effortValue !== undefined ? { effortValue } : {}) } as never,
  }
}
const sseChunk = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const chatChunks = (model: string): string[] => [
  sseChunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
  sseChunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } }),
  'data: [DONE]\n\n',
]
const responsesChunks: string[] = [
  sseChunk({ type: 'response.created', response: { id: 'resp_effort_1' } }),
  sseChunk({ type: 'response.output_text.delta', delta: 'The answer is 4.' }),
  sseChunk({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 4.' }] } }),
  sseChunk({ type: 'response.completed', response: { id: 'resp_effort_1', usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 50 } } } }),
]
const posted: Array<{ url: string; body: Record<string, unknown> }> = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input as never, init)
  const method = (init?.method ?? 'GET').toUpperCase()
  if (url.includes('/models')) return Response.json({ data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] })
  if (method !== 'POST') return Response.json({})
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  posted.push({ url, body })
  if (url.endsWith('/responses')) return sseResponse(responsesChunks)
  if (url.includes('/chat/completions')) return sseResponse(chatChunks(String(body.model ?? 'm')))
  return Response.json({ error: 'unexpected fixture url' }, { status: 404 })
}) as typeof fetch
async function driveRoad(call: AsyncGenerator<unknown>): Promise<{ rows: Row[]; errors: Row[]; body: Record<string, unknown> | undefined }> {
  const before = posted.length
  const items: unknown[] = []
  for await (const item of call) items.push(item)
  return { rows: realRows(items), errors: errorRows(items), body: posted.length > before ? posted.at(-1)?.body : undefined }
}

section('§E the OpenAI road: reasoning.effort on the Responses wire')
{
  __resetOpenaiCatalogueForTest()
  const sol = await driveRoad(openaiCallModel(compatParams('gpt-5.6-sol', 'high', true) as never) as AsyncGenerator<unknown>)
  check('the request rode with reasoning.effort = high', (sol.body?.reasoning as { effort?: string } | undefined)?.effort === 'high', j(sol.body?.reasoning))
  check('the settled row stamps {asked high, applied high, wire reasoning.effort=high}', sameStamp(stampOf(sol.rows.at(-1)), { asked: 'high', applied: 'high', wire: 'reasoning.effort=high' }), `effort ${j(stampOf(sol.rows.at(-1)))} rows ${sol.rows.length} errors ${j(sol.errors.map(e => e.message.content))}`)
}

section('§F the Z.AI road: reasoning_effort on the GLM wire')
{
  const glm = await driveRoad(zaiCallModel(compatParams('glm-5.3', 'high', true) as never) as AsyncGenerator<unknown>)
  check('the request rode with reasoning_effort = high', glm.body?.reasoning_effort === 'high', j(glm.body?.reasoning_effort))
  check('the settled row stamps {asked high, applied high, wire reasoning_effort=high}', sameStamp(stampOf(glm.rows.at(-1)), { asked: 'high', applied: 'high', wire: 'reasoning_effort=high' }), `effort ${j(stampOf(glm.rows.at(-1)))} rows ${glm.rows.length} errors ${j(glm.errors.map(e => e.message.content))}`)
}

section('§G the compat chat roads: reasoning_effort (Kimi), thinking off (DeepSeek), no dial (Hugging Face)')
{
  const kimi = await driveRoad(compatChatCallModel(moonshotLaneProfile, compatParams('kimi-k3', 'high', true)) as AsyncGenerator<unknown>)
  check('Kimi K3 rode with reasoning_effort = high', kimi.body?.reasoning_effort === 'high', j(kimi.body?.reasoning_effort))
  check('the settled row stamps {asked high, applied high, wire reasoning_effort=high}', sameStamp(stampOf(kimi.rows.at(-1)), { asked: 'high', applied: 'high', wire: 'reasoning_effort=high' }), `effort ${j(stampOf(kimi.rows.at(-1)))} errors ${j(kimi.errors.map(e => e.message.content))}`)
  check('every minted row of the request carries the same stamp', kimi.rows.length > 0 && kimi.rows.every(r => sameStamp(r.effort, stampOf(kimi.rows.at(-1)))), j(kimi.rows.map(r => r.effort)))
  const deepseek = await driveRoad(compatChatCallModel(deepseekLaneProfile, compatParams('deepseek-chat', 'high', false)) as AsyncGenerator<unknown>)
  check('DeepSeek with the session thinking off rode thinking.type = disabled and no reasoning_effort', (deepseek.body?.thinking as { type?: string } | undefined)?.type === 'disabled' && deepseek.body?.reasoning_effort === undefined, j({ thinking: deepseek.body?.thinking, reasoning_effort: deepseek.body?.reasoning_effort }))
  check("the settled row stamps {asked high, applied 'thinking off', wire thinking.type=disabled}", sameStamp(stampOf(deepseek.rows.at(-1)), { asked: 'high', applied: 'thinking off', wire: 'thinking.type=disabled' }), `effort ${j(stampOf(deepseek.rows.at(-1)))} errors ${j(deepseek.errors.map(e => e.message.content))}`)
  const hf = await driveRoad(compatChatCallModel(huggingfaceLaneProfile, compatParams('huggingface/org/model', 'high', true)) as AsyncGenerator<unknown>)
  check('Hugging Face rode no effort key', hf.body !== undefined && hf.body.reasoning_effort === undefined && hf.body.reasoning === undefined, j(hf.body))
  check("the settled row stamps {asked high, applied 'not supported by this model', wire none}", sameStamp(stampOf(hf.rows.at(-1)), { asked: 'high', applied: 'not supported by this model', wire: 'none' }), `effort ${j(stampOf(hf.rows.at(-1)))} errors ${j(hf.errors.map(e => e.message.content))}`)
}

section('§H the local road on the native Ollama wire: think on / think off — the record carries the exact think value')
{
  const MODEL = 'thinker:27b'
  const DETAILS = { parent_model: '', format: 'gguf', family: 'qwen3', families: ['qwen3'], parameter_size: '27B', quantization_level: 'Q4_K_M' }
  const row = (data: Record<string, unknown>): string => `${JSON.stringify({ model: MODEL, created_at: '2026-01-01T00:00:00Z', ...data })}\n`
  const chatPosts: Array<{ url: string; body: Record<string, unknown> }> = []
  const server: Server = createServer((req, res) => {
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    let raw = ''
    req.on('data', chunk => {
      raw += String(chunk)
    })
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/tags') return json({ models: [{ name: MODEL, model: MODEL, modified_at: '2026-01-01T00:00:00Z', size: 17_000_000_000, digest: 'aa11', details: DETAILS, capabilities: ['completion', 'tools', 'thinking'] }] })
      if (req.method === 'GET' && req.url === '/api/version') return json({ version: '0.34.4' })
      if (req.method === 'GET' && req.url === '/api/ps') return json({ models: [{ name: MODEL, model: MODEL, size: 17_000_000_000, digest: 'aa11', details: DETAILS, expires_at: '2026-01-01T00:00:00Z', size_vram: 17_000_000_000, context_length: 32768 }] })
      if (req.method === 'POST' && req.url === '/api/show') return json({ modelfile: '', parameters: '', template: '{{ .Prompt }}', details: DETAILS, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 262144 }, capabilities: ['completion', 'tools', 'thinking'], thinking: { values: [false, true], default: true } })
      if (req.method === 'POST' && req.url === '/api/chat') {
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(raw) as Record<string, unknown>
        } catch {
          body = {}
        }
        chatPosts.push({ url: req.url, body })
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(row({ message: { role: 'assistant', content: 'pong' }, done: false }))
        res.write(row({ message: { role: 'assistant', content: '' }, done_reason: 'stop', done: true, prompt_eval_count: 11, eval_count: 4 }))
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  discovery.__resetLocalDiscoveryForTest()
  await discovery.refreshLocalDiscovery({ force: true, env: { MERCURY_LOCAL_PROBE_TARGETS: `ollama=${root}` } as NodeJS.ProcessEnv, timeoutMs: 2_000 })
  const modelRecord = discovery.localModelRecord(MODEL)
  check('the fixture Ollama was discovered with thinking declared (never the live 11434)', modelRecord?.baseUrl === `${root}/v1` && modelRecord.thinkingDeclared === true, j(modelRecord))
  if (modelRecord) {
    windows.__resetLocalWindowsForTest()
    windows.decideLocalWindow(modelRecord, 5_000, undefined)
    const on = await driveRoad(compatChatCallModel(localLaneProfileFor(modelRecord), compatParams(`local/${MODEL}`, 'high', true)) as AsyncGenerator<unknown>)
    const onPost = chatPosts.at(-1)
    check('thinking ON: the /api/chat body carries think: true and no reasoning_effort (the native wire drops it)', onPost?.url === '/api/chat' && onPost.body.think === true && !('reasoning_effort' in onPost.body), j({ url: onPost?.url, think: onPost?.body.think, keys: Object.keys(onPost?.body ?? {}) }))
    check("the settled row stamps {asked high, applied 'thinking on', wire think=true}", sameStamp(stampOf(on.rows.at(-1)), { asked: 'high', applied: 'thinking on', wire: 'think=true' }), `effort ${j(stampOf(on.rows.at(-1)))} errors ${j(on.errors.map(e => e.message.content))}`)
    const off = await driveRoad(compatChatCallModel(localLaneProfileFor(modelRecord), compatParams(`local/${MODEL}`, 'high', false)) as AsyncGenerator<unknown>)
    const offPost = chatPosts.at(-1)
    check('thinking OFF: the /api/chat body carries think: false', offPost?.url === '/api/chat' && offPost.body.think === false, j({ url: offPost?.url, think: offPost?.body.think }))
    check("the settled row stamps {asked high, applied 'thinking off', wire think=false}", sameStamp(stampOf(off.rows.at(-1)), { asked: 'high', applied: 'thinking off', wire: 'think=false' }), `effort ${j(stampOf(off.rows.at(-1)))} errors ${j(off.errors.map(e => e.message.content))}`)
  }
  server.close()
}

globalThis.fetch = realFetch
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
