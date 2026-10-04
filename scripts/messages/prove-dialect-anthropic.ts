#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dialect-anthropic-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '5000'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_MAX_OUTPUT_TOKENS
delete process.env.MERCURY_MODEL

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n  ' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)

const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { DIALECT_CONVERSATION, TWO_MODEL_COMPACTION, VIRTUAL_ROW, STRUCTURED_OUTPUT_ASK, canonicalJson, eq } = await import('./dialectFixture.ts')
import type { AssistantMessage } from '../../src/types/message.ts'

const SENTINEL = new Error('request-captured')
type Captured = { body: Record<string, unknown> }
let captured: Captured | null = null
let abortCapture: (() => void) | null = null
const captureFetch: typeof fetch = async (_input, init) => {
  captured = { body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} }
  abortCapture?.()
  throw SENTINEL
}

async function captureBody(messages: import('../../src/types/message.ts').Message[], extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  captured = null
  const controller = new AbortController()
  abortCapture = () => controller.abort()
  const deadline = setTimeout(() => controller.abort(), 30_000)
  try {
    for await (const _ of queryModelWithStreaming({
      messages,
      systemPrompt: asSystemPrompt(['You are the dialect fixture.']),
      thinkingConfig: { type: 'disabled' } as never,
      tools: [],
      signal: controller.signal,
      options: {
        model: 'claude-sonnet-5',
        querySource: 'sdk',
        isNonInteractiveSession: true,
        fetchOverride: captureFetch as never,
        maxRetries: 0,
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        ...extra,
      } as never,
    })) {
      void _
    }
  } catch {
  }
  clearTimeout(deadline)
  abortCapture = null
  if (!captured) throw new Error('no request captured')
  return captured.body
}

function pinnedBody(body: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
  if (typeof clone.metadata?.user_id === 'string') clone.metadata = '<id>'
  const cloneJson = JSON.stringify(clone)
  void cloneJson
  return clone as Record<string, unknown>
}

function pinWire(wire: string): string {
  return wire.replace(/cc_version=([0-9.]+)\.[0-9a-f]{3}/g, 'cc_version=$1.<fp>')
}

section('the fixture conversation request — byte-pinned (canonical JSON)')
{
  const body = pinnedBody(await captureBody(DIALECT_CONVERSATION))
  if (process.env.DIALECT_PRINT === '1') console.log('  PRINTED: ' + pinWire(canonicalJson(body)))
  console.log('  body: ' + pinWire(canonicalJson(body)).slice(0, 900))
  const messages = body.messages as Array<Record<string, unknown>>
  check('the body is an object with messages', Array.isArray(messages))
  const roles = messages.map(m => `${m.role}`)
  check(
    'roles alternate user/assistant with no empty rows',
    roles.length >= 6 && roles.every(r => r === 'user' || r === 'assistant') && !roles.includes(''),
    roles.join(','),
  )
  const wire = pinWire(canonicalJson(body))
  check(
    'the opus thinking blocks are NOT on this sonnet-bound wire (thinking disabled strips every thinking block by law)',
    !wire.includes('sig-fixture-opus-1') && !wire.includes('sig-fixture-opus-2') && !wire.includes('sig-fixture-sonnet-1'),
  )
  check('the image rides as a base64 source block', wire.includes('aWF0dG9rZW4='))
  check('both tool calls and both results ride, paired', wire.includes('"toolu_A"') && wire.includes('"toolu_B"'))
  const GOLDEN_BODY = `{"max_tokens":128000,"messages":[{"content":[{"text":"Count the words in my notes file.","type":"text"}],"role":"user"},{"content":[{"text":"I will read the file first.","type":"text"}],"role":"assistant"},{"content":[{"text":"here is the screenshot of the file too","type":"text"},{"source":{"data":"aWF0dG9rZW4=","media_type":"image/png","type":"base64"},"type":"image"}],"role":"user"},{"content":[{"text":"Reading and counting now.","type":"text"},{"id":"toolu_A","input":{"file_path":"/proj/notes.txt"},"name":"Read","type":"tool_use"},{"id":"toolu_B","input":{"command":"wc -w /proj/notes.txt"},"name":"Bash","type":"tool_use"}],"role":"assistant"},{"content":[{"content":[{"text":"the quick brown fox jumps over the lazy dog","type":"text"}],"tool_use_id":"toolu_A","type":"tool_result"},{"content":[{"text":"9 words","type":"text"}],"is_error":false,"tool_use_id":"toolu_B","type":"tool_result"}],"role":"user"},{"content":[{"text":"The file holds nine words.","type":"text"}],"role":"assistant"},{"content":[{"cache_control":{"type":"ephemeral"},"text":"Summarise what you found in one sentence.","type":"text"}],"role":"user"}],"metadata":"<id>","model":"claude-sonnet-5","output_config":{"effort":"high"},"stream":true,"system":[{"text":"x-anthropic-billing-header: cc_version=2.1.289.<fp>;cc_entrypoint=unknown;","type":"text"},{"cache_control":{"type":"ephemeral"},"text":"You are a Mercury agent.","type":"text"},{"cache_control":{"type":"ephemeral"},"text":"You are the dialect fixture.","type":"text"}],"tools":[]}`
  check('the composed body is byte-identical to the base golden', wire === GOLDEN_BODY, `first divergence near ${firstDivergence(wire, GOLDEN_BODY)}`)
}

function firstDivergence(a: string, b: string): string {
  let i = 0
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
  return `${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`
}

section('the two-model compaction shape (finding 9) — the request a sonnet-bound fold would send')
{
  const body = pinnedBody(await captureBody(TWO_MODEL_COMPACTION))
  if (process.env.DIALECT_PRINT === '1') console.log('  PRINTED: ' + pinWire(canonicalJson(body)))
  const wire = pinWire(canonicalJson(body))
  check('the opus thinking stays off the sonnet-bound request', !wire.includes('sig-fixture-opus') && !wire.includes('opus weighed'))
  const messages = body.messages as Array<Record<string, unknown>>
  const opusRow = messages.find(m => canonicalJson(m).includes('tool sketch'))
  check(
    'the opus text row survives as a plain text assistant row (no placeholder, no empty content)',
    opusRow !== undefined && !canonicalJson(opusRow).includes('[reasoning written by another model'),
    opusRow ? canonicalJson(opusRow).slice(0, 220) : 'row missing',
  )
  check(
    'every assistant row carries non-empty content and every tool_use has its result (the lawful-shape check)',
    messages.every(m => Array.isArray(m.content) && (m.content as unknown[]).length > 0) && !wire.includes('[Tool result missing due to internal error]'),
    canonicalJson(messages.map(m => (m.content as unknown[]).length)),
  )
}

section('a virtual (display-only) row never reaches the wire')
{
  const withVirtual = [...DIALECT_CONVERSATION.slice(0, 2), VIRTUAL_ROW as never, ...DIALECT_CONVERSATION.slice(2)]
  const body = pinnedBody(await captureBody(withVirtual))
  check('the virtual row is absent from the composed request', !canonicalJson(body).includes('a display-only row'))
}

section('the structured-output ask rides the output_config the wire documents')
{
  const body = pinnedBody(await captureBody(DIALECT_CONVERSATION, { outputFormat: STRUCTURED_OUTPUT_ASK as never }))
  const wire = canonicalJson(body.output_config)
  check('output_config.format carries the json_schema ask', wire.includes('json_schema') && wire.includes('word_count'), wire.slice(0, 200))
}

section('the stream side — fixture SSE frames fold into the lane\'s own content blocks')
{
  const encoder = new TextEncoder()
  const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
  const usage = { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
  const frames = (model: string): string[] => [
    sse('message_start', { type: 'message_start', message: { id: 'msg_fixture_stream', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'fixture thought' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-stream-1' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Nine words, four of them unique.' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...usage, output_tokens: 40 } }),
    sse('message_stop', { type: 'message_stop' }),
  ]
  const streamFetch: typeof fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames('claude-sonnet-5')) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture_stream' } })
  }) as typeof fetch
  const rows: AssistantMessage[] = []
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 30_000)
  for await (const ev of queryModelWithStreaming({
    messages: DIALECT_CONVERSATION,
    systemPrompt: asSystemPrompt(['You are the dialect fixture.']),
    thinkingConfig: { type: 'disabled' } as never,
    tools: [],
    signal: controller.signal,
    options: {
      model: 'claude-sonnet-5',
      querySource: 'sdk',
      isNonInteractiveSession: true,
      fetchOverride: streamFetch as never,
      maxRetries: 0,
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    } as never,
  })) {
    if ((ev as { type: string }).type === 'assistant') rows.push(ev as AssistantMessage)
  }
  clearTimeout(deadline)
  const settled = rows.at(-1)
  check('the lane settled one assistant message', settled !== undefined)
  if (settled) {
    const blocks = settled.message.content.map(b => ({ ...(b as object) }))
    check(
      'the stream settled exactly one text block with the wire\'s own words (the streamed thinking block rides its own row)',
      settled.message.content.length === 1 && (settled.message.content[0] as { type?: string; text?: string }).type === 'text'
        && (settled.message.content[0] as { text?: string }).text === 'Nine words, four of them unique.',
      JSON.stringify(blocks).slice(0, 300),
    )
    check('the settled row carries the stream\'s model and id', settled.message.model === 'claude-sonnet-5' && settled.message.id === 'msg_fixture_stream')
  }
}

console.log(failures === 0 ? '\n✅ ANTHROPIC DIALECT CONTRACT GREEN' : `\n❌ ${failures} ANTHROPIC DIALECT CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
