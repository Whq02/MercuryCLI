#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-tool-arguments-shapes-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { streamOllamaChat } = await import('../../src/services/providers/local/ollamaChatTransport.ts')
const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
type CompatStreamEvent = import('../../src/services/providers/openaicompat/compatChatClient.ts').CompatStreamEvent
type CompatCompletedToolCall = import('../../src/services/providers/openaicompat/compatChatClient.ts').CompatCompletedToolCall

const ARGS = { file_path: '/tmp/a.ts', offset: 12 }
const request = { model: 'qwen3.5:9b', messages: [{ role: 'user' as const, content: 'read it' }], tools: [{ type: 'function' as const, function: { name: 'Read', parameters: { type: 'object' } } }] }

const ndjson = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const sse = (chunks: unknown[]): string => chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
const fetchOf = (body: string, contentType: string): typeof fetch => (async () => new Response(body, { status: 200, headers: { 'content-type': contentType } })) as unknown as typeof fetch

async function settle(events: AsyncGenerator<CompatStreamEvent>): Promise<{ calls: CompatCompletedToolCall[]; reason: string | undefined; faults: string[] }> {
  let calls: CompatCompletedToolCall[] = []
  let reason: string | undefined
  const faults: string[] = []
  for await (const event of events) {
    if (event.type === 'finish') {
      calls = event.toolCalls
      reason = event.reason
    }
    if (event.type === 'stream-fault') faults.push(event.fault.code)
  }
  return { calls, reason, faults }
}

async function ollama(args: unknown): Promise<Awaited<ReturnType<typeof settle>>> {
  const body = ndjson([
    { model: 'qwen3.5:9b', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Read', arguments: args } }] }, done: false },
    { model: 'qwen3.5:9b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 9, eval_count: 3 },
  ])
  return settle(streamOllamaChat({ url: 'http://fixture.invalid/api/chat', request, fetchImpl: fetchOf(body, 'application/x-ndjson') }, {}))
}

async function compat(args: unknown): Promise<Awaited<ReturnType<typeof settle>>> {
  const body = sse([
    { id: 'c1', model: 'qwen3.5:9b', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: args } }] }, finish_reason: null }] },
    { id: 'c1', model: 'qwen3.5:9b', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  return settle(streamCompatChat({ url: 'http://fixture.invalid/v1/chat/completions', request, fetchImpl: fetchOf(body, 'text/event-stream') }))
}

const shapeOf = (c: CompatCompletedToolCall | undefined): string => (c === undefined ? 'no call' : `${c.name} malformed=${c.malformed} arguments=${JSON.stringify(c.arguments)} raw=${c.argumentsRaw}`)

section('1 · Ollama /api/chat: function.arguments as a JSON object (the documented shape) and as a JSON string (llama.cpp-backed renderers) settle the same call')
{
  const object = await ollama(ARGS)
  const string = await ollama(JSON.stringify(ARGS))
  check('the object shape settles one validated call', object.calls.length === 1 && object.calls[0]!.malformed === false && JSON.stringify(object.calls[0]!.arguments) === JSON.stringify(ARGS), shapeOf(object.calls[0]))
  check('the string shape settles the same call (arguments parsed, not dropped to {})', string.calls.length === 1 && string.calls[0]!.malformed === false && JSON.stringify(string.calls[0]!.arguments) === JSON.stringify(ARGS), shapeOf(string.calls[0]))
  check('both finish as tool_calls', object.reason === 'tool_calls' && string.reason === 'tool_calls', `${object.reason} · ${string.reason}`)
  check('the two settled records agree (name, arguments, malformed)', shapeOf(object.calls[0]) === shapeOf(string.calls[0]), `${shapeOf(object.calls[0])} vs ${shapeOf(string.calls[0])}`)
  check('no fault rode either stream', object.faults.length === 0 && string.faults.length === 0, [...object.faults, ...string.faults].join(','))
}

section('2 · /v1/chat/completions: function.arguments as a string (the OpenAI shape) and as a parsed object (llama-server #20198) settle the same call')
{
  const string = await compat(JSON.stringify(ARGS))
  const object = await compat(ARGS)
  check('the string shape settles one validated call', string.calls.length === 1 && string.calls[0]!.malformed === false && JSON.stringify(string.calls[0]!.arguments) === JSON.stringify(ARGS), shapeOf(string.calls[0]))
  check('the object shape settles the same call (serialised, not read as an empty fragment)', object.calls.length === 1 && object.calls[0]!.malformed === false && JSON.stringify(object.calls[0]!.arguments) === JSON.stringify(ARGS), shapeOf(object.calls[0]))
  check('the two settled records agree (name, arguments, malformed)', shapeOf(string.calls[0]) === shapeOf(object.calls[0]), `${shapeOf(string.calls[0])} vs ${shapeOf(object.calls[0])}`)
  check('both finish as tool_calls', string.reason === 'tool_calls' && object.reason === 'tool_calls', `${string.reason} · ${object.reason}`)
}

section('3 · a string that is not JSON stays the refusal it is today on both roads (malformed, never a silent {})')
{
  const ollamaBad = await ollama('{"file_path": ')
  const compatBad = await compat('{"file_path": ')
  check('Ollama: the call is marked malformed and carries no parsed arguments', ollamaBad.calls.length === 1 && ollamaBad.calls[0]!.malformed === true && ollamaBad.calls[0]!.arguments === undefined, shapeOf(ollamaBad.calls[0]))
  check('Ollama: the raw text is kept for the refusal note', ollamaBad.calls[0]?.argumentsRaw === '{"file_path": ', ollamaBad.calls[0]?.argumentsRaw)
  check('compat: the call is marked malformed and carries no parsed arguments', compatBad.calls.length === 1 && compatBad.calls[0]!.malformed === true && compatBad.calls[0]!.arguments === undefined, shapeOf(compatBad.calls[0]))
}

section('4 · the empty cases: no arguments at all reads as {} on both roads')
{
  const ollamaNone = await ollama(undefined)
  const compatNone = await compat(undefined)
  check('Ollama: a call without arguments settles {}', ollamaNone.calls.length === 1 && ollamaNone.calls[0]!.malformed === false && JSON.stringify(ollamaNone.calls[0]!.arguments) === '{}', shapeOf(ollamaNone.calls[0]))
  check('compat: a call without arguments settles {}', compatNone.calls.length === 1 && compatNone.calls[0]!.malformed === false && JSON.stringify(compatNone.calls[0]!.arguments) === '{}', shapeOf(compatNone.calls[0]))
}

console.log(failures === 0 ? '\nprove-local-tool-arguments-shapes: ALL GREEN' : `\nprove-local-tool-arguments-shapes: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
