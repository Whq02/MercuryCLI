#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stream-end-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

import { z } from 'zod/v4'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'stream-end-proj-'))
bootstrap.setOriginalCwd(projDir)
bootstrap.setProjectRoot(projDir)

const { ask } = await import('../../src/rows/turn.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
import type { Message } from '../../src/types/message.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the stream-end proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const MODEL = 'claude-opus-5-5'
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const messageStart = (id: string): string =>
  sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } })
const blockStart = (index: number, block: Record<string, unknown>): string => sse('content_block_start', { type: 'content_block_start', index, content_block: block })
const blockDelta = (index: number, delta: Record<string, unknown>): string => sse('content_block_delta', { type: 'content_block_delta', index, delta })
const blockStop = (index: number): string => sse('content_block_stop', { type: 'content_block_stop', index })
const textOpen = (index: number, text: string): string => blockStart(index, { type: 'text', text: '' }) + blockDelta(index, { type: 'text_delta', text })
const textWhole = (index: number, text: string): string => textOpen(index, text) + blockStop(index)
const thinkingWhole = (index: number, thinking: string): string =>
  blockStart(index, { type: 'thinking', thinking: '', signature: '' }) + blockDelta(index, { type: 'thinking_delta', thinking }) + blockDelta(index, { type: 'signature_delta', signature: 'sig-fixture' }) + blockStop(index)
const toolOpen = (index: number, id: string, name: string, partialJson: string): string =>
  blockStart(index, { type: 'tool_use', id, name, input: {} }) + blockDelta(index, { type: 'input_json_delta', partial_json: partialJson })
const toolWhole = (index: number, id: string, name: string, json: string): string => toolOpen(index, id, name, json) + blockStop(index)
const messageEnd = (stop: string): string =>
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } }) + sse('message_stop', { type: 'message_stop' })

type Reply = (n: number, res: ServerResponse, body: { stream?: unknown }) => void

async function startLoopback(reply: Reply): Promise<{ url: string; modelRequests: () => number; close: () => Promise<void> }> {
  let n = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const url = req.url ?? ''
      if (url.includes('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 100 }))
        return
      }
      if (!url.includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: { stream?: unknown } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: unknown }
      } catch {
        body = {}
      }
      n++
      reply(n, res, body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    modelRequests: () => n,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

const sseHead = (res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
}
function oneShot(res: ServerResponse, id: string, content: unknown[], stop: string): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: MODEL, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 12 } }))
}
function wholeReply(n: number, res: ServerResponse, body: { stream?: unknown }, text: string): void {
  if (body.stream !== true) {
    oneShot(res, `msg_whole_${n}`, [{ type: 'text', text }], 'end_turn')
    return
  }
  sseHead(res)
  res.end(messageStart(`msg_whole_${n}`) + textWhole(0, text) + messageEnd('end_turn'))
}

function makeStore(): { getAppState: () => Record<string, unknown>; setAppState: (f: (prev: Record<string, unknown>) => Record<string, unknown>) => void } {
  let state: Record<string, unknown> = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    todos: {},
    agentNameRegistry: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    fileHistory: { snapshots: new Map(), fileVersions: new Map() },
    attribution: {},
  }
  return {
    getAppState: () => state,
    setAppState: f => {
      state = f(state)
    },
  }
}

type Ran = { tool: string; input: Record<string, unknown> }
const ran: Ran[] = []
const probeTool = (name: string, reads: boolean): Record<string, unknown> => ({
  name,
  isMcp: false,
  inputSchema: z.object({}).passthrough(),
  isConcurrencySafe: () => reads,
  isReadOnly: () => reads,
  checkPermissions: async () => ({ behavior: 'passthrough', message: 'ask the wrapper' }),
  description: async () => 'probe tool',
  prompt: async () => 'probe tool prompt',
  mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', content: typeof data === 'string' ? data : j(data), tool_use_id: id }),
  call: async (input: Record<string, unknown>) => {
    ran.push({ tool: name, input })
    return { data: 'probe tool ran' }
  },
})
const READER = 'StreamEndReader'
const WRITER = 'StreamEndWriter'

type Row = Record<string, unknown> & { type: string }
type Scene = { rows: Row[]; conversation: Message[]; requests: number; ran: Ran[] }

async function scene(reply: Reply): Promise<Scene> {
  ran.length = 0
  const api = await startLoopback(reply)
  process.env.ANTHROPIC_BASE_URL = api.url
  const store = makeStore()
  const readCache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
  const rows: Row[] = []
  const conversation: Message[] = []
  try {
    for await (const row of ask({
      commands: [],
      prompt: 'Reply once.',
      cwd: projDir,
      tools: [probeTool(READER, true), probeTool(WRITER, false)] as never,
      mcpClients: [],
      canUseTool: (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never,
      getAppState: store.getAppState as never,
      setAppState: store.setAppState as never,
      getReadFileCache: () => readCache,
      setReadFileCache: () => {},
      userSpecifiedModel: MODEL,
      abortController: new AbortController(),
      mutableMessages: conversation,
    })) {
      rows.push(row as Row)
    }
  } finally {
    await api.close()
  }
  return { rows, conversation, requests: api.modelRequests(), ran: [...ran] }
}

const outcomeOf = (s: Scene): Row & { status?: string; answer?: string } => s.rows.at(-1) as Row & { status?: string; answer?: string }
const faultWords = (s: Scene): string[] =>
  s.rows
    .filter(row => row.type === 'notice' || row.type === 'wait')
    .map(row => `${String(row.text ?? '')} ${String(row.reason ?? '')}`.trim())
    .filter(words => /stream|connection/i.test(words))
const noticeTexts = (s: Scene): string[] => s.rows.filter(row => row.type === 'notice').map(row => String(row.text ?? ''))
const waitsAndNotices = (s: Scene): string => j(s.rows.filter(row => row.type === 'notice' || row.type === 'wait'))
const settledAs = (s: Scene, answer: string): boolean => outcomeOf(s)?.status === 'completed' && outcomeOf(s)?.answer === answer
const outcomeWords = (s: Scene): string => j({ status: outcomeOf(s)?.status, answer: outcomeOf(s)?.answer, requests: s.requests })

function replyRows(conversation: readonly Message[], id: string): Message[] {
  return conversation.filter(row => row.type === 'assistant' && row.isApiErrorMessage !== true && row.message.id === id)
}

console.log('============================================================')
console.log(' a stream that closes without its end event is never a finished reply')
console.log('============================================================')

section('E1 — a text block settled, then the response closes inside a tool call\'s input (a clean close: no message_delta, no message_stop, no transport error)')
{
  const s = await scene((n, res, body) => {
    if (n === 1) {
      sseHead(res)
      res.write(messageStart('msg_e1') + textWhole(0, 'I will run the probe tool now.') + toolOpen(1, 'toolu_e1', READER, '{"path": "/tmp/ha'))
      res.end()
      return
    }
    wholeReply(n, res, body, 'E1 WHOLE REPLY.')
  })
  check('the cut reply is not the turn\'s completed answer', !settledAs(s, 'I will run the probe tool now.'), outcomeWords(s))
  check('the turn reaches a whole reply by one more request', s.requests === 2 && settledAs(s, 'E1 WHOLE REPLY.'), outcomeWords(s))
  check('the record names the fault (a notice or a wait row about the stream)', faultWords(s).length > 0, waitsAndNotices(s))
  check('the cut tool call never ran', s.ran.length === 0, j(s.ran))
}

section('E2 — a thinking block settled, then the response closes inside the text block')
{
  const s = await scene((n, res, body) => {
    if (n === 1) {
      sseHead(res)
      res.write(messageStart('msg_e2') + thinkingWhole(0, 'Let me think about it.') + textOpen(1, 'The answer is forty'))
      res.end()
      return
    }
    wholeReply(n, res, body, 'E2 WHOLE REPLY.')
  })
  check('the turn is not named a thinking-only turn (the text was cut, not withheld)', !noticeTexts(s).some(text => text.includes('carried thinking only')), j(noticeTexts(s)))
  check('the record names the fault (a notice or a wait row about the stream)', faultWords(s).length > 0, waitsAndNotices(s))
  check('the turn reaches a whole reply by one more request', s.requests === 2 && settledAs(s, 'E2 WHOLE REPLY.'), outcomeWords(s))
}

section('E3 — a whole tool call settled, then the response closes before message_delta: the call stands, the receipt names the missing end')
{
  const s = await scene((n, res, body) => {
    if (n === 1) {
      sseHead(res)
      res.write(messageStart('msg_e3') + textWhole(0, 'Running it.') + toolWhole(1, 'toolu_e3', READER, '{}'))
      res.end()
      return
    }
    wholeReply(n, res, body, 'E3 WHOLE REPLY.')
  })
  check('the turn goes on to a whole reply', s.requests === 2 && settledAs(s, 'E3 WHOLE REPLY.'), outcomeWords(s))
  check('the whole call ran exactly once (the close is not answered by a second request for the same reply)', s.ran.length === 1, j(s.ran))
  check('the receipt is the sentence its text-only twin prints', noticeTexts(s).includes('the Anthropic stream closed without its end event after its last item; the reply stands'), j(noticeTexts(s)))
  const last = replyRows(s.conversation, 'msg_e3').at(-1)
  check('the call\'s row carries the tool_use stop reason and the typed end', last?.type === 'assistant' && last.message.stop_reason === 'tool_use' && last.streamEnd?.reason === 'closed-after-last-item', j({ stop: last?.type === 'assistant' ? last.message.stop_reason : null, streamEnd: last?.type === 'assistant' ? last.streamEnd : null }))
  check('the measured usage stays on the row (nothing zeroed)', last?.type === 'assistant' && last.message.usage.input_tokens === 25, j(last?.type === 'assistant' ? last.message.usage : null))
}

section('E4 — a thinking block settled and nothing after it, then the response closes')
{
  const s = await scene((n, res, body) => {
    if (n === 1) {
      sseHead(res)
      res.write(messageStart('msg_e4') + thinkingWhole(0, 'Let me think about it.'))
      res.end()
      return
    }
    wholeReply(n, res, body, 'E4 WHOLE REPLY.')
  })
  check('the turn is not named a thinking-only turn (the reply was cut before it could say anything)', !noticeTexts(s).some(text => text.includes('carried thinking only')), j(noticeTexts(s)))
  check('the record names the fault (a notice or a wait row about the stream)', faultWords(s).length > 0, waitsAndNotices(s))
  check('the turn reaches a whole reply by one more request', s.requests === 2 && settledAs(s, 'E4 WHOLE REPLY.'), outcomeWords(s))
}

section('E5 — a whole read settled, then the response closes inside a second call; the one-shot completion asks for the read again')
{
  const s = await scene((n, res, body) => {
    if (n === 1) {
      sseHead(res)
      res.write(messageStart('msg_e5') + toolWhole(0, 'toolu_e5_a', READER, '{"which":"a"}') + toolOpen(1, 'toolu_e5_b', READER, '{"which": "b'))
      res.end()
      return
    }
    if (n === 2 && body.stream !== true) {
      oneShot(res, 'msg_e5_again', [{ type: 'tool_use', id: 'toolu_e5_a2', name: READER, input: { which: 'a' } }], 'tool_use')
      return
    }
    wholeReply(n, res, body, 'E5 WHOLE REPLY.')
  })
  check('the cut second call never ran', s.ran.every(call => call.input.which !== 'b'), j(s.ran))
  check('the record names the fault (a notice or a wait row about the stream)', faultWords(s).length > 0, waitsAndNotices(s))
  check('the turn reaches a whole reply', settledAs(s, 'E5 WHOLE REPLY.'), outcomeWords(s))
  console.log(`  [NOTE] the read ran ${s.ran.length} time(s): a read that started while the reply streamed is thrown away at the retry and its identical call runs again — an open row of the early-start road, counted here and not pinned`)
}

section('E6 — a whole read and then a whole text block settled, then the response closes')
{
  const s = await scene((n, res, body) => {
    if (n === 1) {
      sseHead(res)
      res.write(messageStart('msg_e6') + toolWhole(0, 'toolu_e6', READER, '{"which":"a"}') + textWhole(1, 'And then some words.'))
      res.end()
      return
    }
    wholeReply(n, res, body, 'E6 WHOLE REPLY.')
  })
  check('the cut reply is not the turn\'s completed answer', !settledAs(s, 'And then some words.'), outcomeWords(s))
  check('the record names the fault (a notice or a wait row about the stream)', faultWords(s).length > 0, waitsAndNotices(s))
  check('the turn reaches a whole reply', settledAs(s, 'E6 WHOLE REPLY.'), outcomeWords(s))
}

section('W1 — a whole WRITING call settled, then the response closes inside a second call; the one-shot completion asks for the write again')
{
  const s = await scene((n, res, body) => {
    if (n === 1) {
      sseHead(res)
      res.write(messageStart('msg_w1') + toolWhole(0, 'toolu_w1_a', WRITER, '{"which":"a"}') + toolOpen(1, 'toolu_w1_b', WRITER, '{"which": "b'))
      res.end()
      return
    }
    if (n === 2 && body.stream !== true) {
      oneShot(res, 'msg_w1_again', [{ type: 'tool_use', id: 'toolu_w1_a2', name: WRITER, input: { which: 'a' } }], 'tool_use')
      return
    }
    wholeReply(n, res, body, 'W1 WHOLE REPLY.')
  })
  check('the write ran exactly once (it never starts before its reply has ended, so the retry is its only run)', s.ran.length === 1 && s.ran[0]?.tool === WRITER && s.ran[0]?.input.which === 'a', j(s.ran))
  check('the cut second write never ran', s.ran.every(call => call.input.which !== 'b'), j(s.ran))
  check('the turn reaches a whole reply', settledAs(s, 'W1 WHOLE REPLY.'), outcomeWords(s))
}

section('W2 — a whole WRITING call settled, then the response closes before message_delta: the typed end runs it once')
{
  const s = await scene((n, res, body) => {
    if (n === 1) {
      sseHead(res)
      res.write(messageStart('msg_w2') + toolWhole(0, 'toolu_w2', WRITER, '{"which":"a"}'))
      res.end()
      return
    }
    wholeReply(n, res, body, 'W2 WHOLE REPLY.')
  })
  check('the write ran exactly once', s.ran.length === 1 && s.ran[0]?.tool === WRITER, j(s.ran))
  check('two requests: the closed reply and the one that reads the result', s.requests === 2 && settledAs(s, 'W2 WHOLE REPLY.'), outcomeWords(s))
}

section('C1 — the control: a text block settled, then the close (the typed end that already stood)')
{
  const s = await scene((n, res, body) => {
    if (n === 1) {
      sseHead(res)
      res.write(messageStart('msg_c1') + textWhole(0, 'A whole paragraph that ended.'))
      res.end()
      return
    }
    wholeReply(n, res, body, 'C1 UNEXPECTED SECOND REPLY.')
  })
  check('one request; the reply stands as the answer', s.requests === 1 && settledAs(s, 'A whole paragraph that ended.'), outcomeWords(s))
  check('the receipt names the missing end event', noticeTexts(s).includes('the Anthropic stream closed without its end event after its last item; the reply stands'), j(noticeTexts(s)))
  const last = replyRows(s.conversation, 'msg_c1').at(-1)
  check('the reply carries end_turn and the typed end', last?.type === 'assistant' && last.message.stop_reason === 'end_turn' && last.streamEnd?.reason === 'closed-after-last-item', j(last?.type === 'assistant' ? { stop: last.message.stop_reason, streamEnd: last.streamEnd } : null))
}

section('C2 — the control: the close inside the first block (nothing settled) was already retried')
{
  const s = await scene((n, res, body) => {
    if (n === 1) {
      sseHead(res)
      res.write(messageStart('msg_c2') + blockStart(0, { type: 'thinking', thinking: '', signature: '' }) + blockDelta(0, { type: 'thinking_delta', thinking: 'Let me think about' }))
      res.end()
      return
    }
    wholeReply(n, res, body, 'C2 WHOLE REPLY.')
  })
  check('a second request answers the turn', s.requests === 2 && settledAs(s, 'C2 WHOLE REPLY.'), outcomeWords(s))
  check('the record names the fault', faultWords(s).length > 0, waitsAndNotices(s))
}

section('C3 — the control: a whole reply with its end event is one request and no notice')
{
  const s = await scene((n, res, body) => wholeReply(n, res, body, 'C3 WHOLE REPLY.'))
  check('one request, completed, no stream notice', s.requests === 1 && settledAs(s, 'C3 WHOLE REPLY.') && faultWords(s).length === 0, `${outcomeWords(s)} ${waitsAndNotices(s)}`)
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ STREAM END GREEN (${checks} checks)` : ` ❌ ${failures} of ${checks} STREAM END CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
