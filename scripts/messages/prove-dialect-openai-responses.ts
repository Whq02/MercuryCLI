#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dialect-openai-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.OPENAI_API_KEY = 'fixture-openai-key'
process.env.MERCURY_OPENAI_API_BASE = 'https://openai.fixture.invalid/v1'
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '5000'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_MODEL
for (const name of ['MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_BUSY_RETRY_SCALE']) delete process.env[name]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
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

const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { DIALECT_CONVERSATION, VIRTUAL_ROW, STRUCTURED_OUTPUT_ASK, canonicalJson } = await import('./dialectFixture.ts')
import type { AssistantMessage, Message } from '../../src/types/message.ts'

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

const answerChunks = (model: string): string[] => [
  sseChunk({ type: 'response.created', response: { id: 'resp_fixture' } }),
  sseChunk({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_f1', role: 'assistant', status: 'in_progress', content: [] } }),
  sseChunk({ type: 'response.output_text.delta', item_id: 'msg_f1', delta: 'Nine words, four unique.' }),
  sseChunk({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_f1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Nine words, four unique.', annotations: [] }] } }),
  sseChunk({ type: 'response.completed', response: { id: 'resp_fixture', usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 50 } } } }),
]
void answerChunks

type Posted = { url: string; body: Record<string, unknown> }
const posted: Posted[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input as never, init)
  if (url.includes('/models')) return Response.json({ data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] })
  if (!url.includes('/responses')) return Response.json({ error: 'unexpected fixture url' }, { status: 404 })
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  posted.push({ url, body })
  return sseResponse([
    sseChunk({ type: 'response.created', response: { id: 'resp_fixture' } }),
    sseChunk({ type: 'response.output_text.delta', delta: 'Nine words, four unique.' }),
    sseChunk({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Nine words, four unique.' }] } }),
    sseChunk({ type: 'response.completed', response: { id: 'resp_fixture', usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 50 } } } }),
  ])
}) as typeof fetch

async function drive(messages: Message[], extra: Record<string, unknown> = {}): Promise<{ rows: AssistantMessage[]; body: Record<string, unknown> | undefined }> {
  const before = posted.length
  const rows: AssistantMessage[] = []
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 30_000)
  try {
    for await (const item of openaiCallModel({
      messages,
      systemPrompt: asSystemPrompt(['You are the dialect fixture.']),
      thinkingConfig: { type: 'disabled' } as never,
      tools: [],
      signal: controller.signal,
      options: {
        model: 'gpt-5.6-sol',
        querySource: 'sdk',
        isNonInteractiveSession: true,
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        ...extra,
      } as never,
    })) {
      if ((item as { type: string }).type === 'assistant') rows.push(item as AssistantMessage)
    }
  } catch {
  }
  clearTimeout(deadline)
  return { rows, body: posted.length > before ? posted.at(-1)?.body : undefined }
}

function pinned(body: Record<string, unknown> | undefined): Record<string, unknown> {
  if (body === undefined) return {}
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
  if (typeof clone.prompt_cache_key === 'string') clone.prompt_cache_key = '<key>'
  return clone
}

section('the fixture conversation request — byte-pinned (canonical JSON)')
{
  const { body, rows } = await drive(DIALECT_CONVERSATION)
  if (process.env.DIALECT_PRINT === '1') console.log('  PRINTED: ' + canonicalJson(pinned(body)))
  console.log('  body input: ' + canonicalJson(body?.input).slice(0, 900))
  check('a request body was captured', body !== undefined)
  check('the lane settled a row', rows.length > 0)
  const GOLDEN_INPUT = `[{"content":[{"text":"Count the words in my notes file.","type":"input_text"}],"role":"user","type":"message"},{"content":[{"text":"I will read the file first.","type":"output_text"}],"role":"assistant","type":"message"},{"content":[{"text":"here is the screenshot of the file too","type":"input_text"},{"image_url":"data:image/png;base64,aWF0dG9rZW4=","type":"input_image"}],"role":"user","type":"message"},{"content":[{"text":"Reading and counting now.","type":"output_text"}],"role":"assistant","type":"message"},{"arguments":"{\\"file_path\\":\\"/proj/notes.txt\\"}","call_id":"toolu_A","name":"Read","type":"function_call"},{"arguments":"{\\"command\\":\\"wc -w /proj/notes.txt\\"}","call_id":"toolu_B","name":"Bash","type":"function_call"},{"call_id":"toolu_A","output":"the quick brown fox jumps over the lazy dog","type":"function_call_output"},{"call_id":"toolu_B","output":"9 words","type":"function_call_output"},{"content":[{"text":"The file holds nine words.","type":"output_text"}],"role":"assistant","type":"message"},{"content":[{"text":"Summarise what you found in one sentence.","type":"input_text"}],"role":"user","type":"message"}]`
  check('the input items are byte-identical to the base golden', canonicalJson(body?.input) === GOLDEN_INPUT, `first divergence near ${firstDivergence(canonicalJson(body?.input), GOLDEN_INPUT)}`)
  check('store is false and the encrypted-content include rides (the stateless-replay law)', body?.store === false && Array.isArray(body?.include) && canonicalJson(body?.include) === '["reasoning.encrypted_content"]')
  check('the signed sonnet thinking never rides this wire (cross-provider reasoning is not transferable)', !canonicalJson(body?.input).includes('sig-fixture-sonnet-1') && !canonicalJson(body?.input).includes('considering the count'))
}

section('a virtual (display-only) row — the family-lane wire truth')
{
  const withVirtual = [...DIALECT_CONVERSATION.slice(0, 2), VIRTUAL_ROW as never, ...DIALECT_CONVERSATION.slice(2)]
  const { body } = await drive(withVirtual)
  const wire = canonicalJson(body?.input)
  check('the shared request plan keeps a display-only virtual row off the Responses wire', !wire.includes('a display-only row'), wire.slice(0, 260))
}

section('the structured-output ask — the Responses text.format json_schema block')
{
  const { body } = await drive(DIALECT_CONVERSATION, { outputFormat: STRUCTURED_OUTPUT_ASK as never })
  const format = (body?.text as { format?: Record<string, unknown> } | undefined)?.format
  const wire = canonicalJson(format)
  check(
    'text.format carries the strict-dialect schema (every key required, optionals nullable)',
    wire === '{"name":"mercury_structured_output","schema":{"additionalProperties":false,"properties":{"note":{"type":["string","null"]},"words":{"type":"number"}},"required":["words","note"],"type":"object"},"type":"json_schema"}',
    wire.slice(0, 300),
  )
}

section('the stream side — the Responses event vocabulary folds to the lane\'s own rows')
{
  const { rows } = await drive(DIALECT_CONVERSATION)
  const settled = rows.find(r => !(r as { isApiErrorMessage?: boolean }).isApiErrorMessage)
  check('the lane settled a content row', settled !== undefined)
  if (settled) {
    check(
      'the folded row carries the fixture answer text byte-identically',
      canonicalJson(settled.message.content).includes('Nine words, four unique.'),
      canonicalJson(settled.message.content).slice(0, 200),
    )
  }
}

globalThis.fetch = realFetch
console.log(failures === 0 ? '\n✅ OPENAI RESPONSES DIALECT CONTRACT GREEN' : `\n❌ ${failures} OPENAI RESPONSES DIALECT CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

function firstDivergence(a: string, b: string): string {
  let i = 0
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
  return `${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`
}
