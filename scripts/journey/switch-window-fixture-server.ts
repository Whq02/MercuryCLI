#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: switch-window-fixture-server.ts <captureFile> [window] [ceiling] [replyChars] [charsPerToken]')
  process.exit(2)
}
const WINDOW = Number.parseInt(process.argv[3] ?? '20000', 10)
const CEILING = Number.parseInt(process.argv[4] ?? '0', 10)
const REPLY_CHARS = Number.parseInt(process.argv[5] ?? '120000', 10)
const CHARS_PER_TOKEN = Number.parseFloat(process.argv[6] ?? '4')

export const BIG_ASK = 'write the long design note'
export const BIG_REPLY_TAIL = 'the long design note ends here'
export const PICKUP_ASK = 'carry on from the note'
export const GPT_REPLY = 'sol carries on from the note'
export const GPT_SUMMARY = 'SUMMARY BY SOL: the note was written.'
export const OPUS_SUMMARY = 'SUMMARY BY OPUS: the long design note was written and the operator asked to carry on.'
export const OVERFLOW_SENTENCE = 'Your input exceeds the context window of this model. Please adjust your input and try again.'

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const evt = (name: string, obj: unknown): string => `event: ${name}\n${sse(obj)}`
function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}

function bigReplyText(): string {
  const sentence = 'The note walks the module boundaries, the ports, the records and the checks that keep them honest. '
  let out = ''
  while (out.length < REPLY_CHARS - BIG_REPLY_TAIL.length - 1) out += sentence
  return `${out}\n${BIG_REPLY_TAIL}`
}

function anthropicText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []
  const texts: string[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') texts.push(c)
    else if (Array.isArray(c)) for (const b of c as Array<{ type?: string; text?: string }>) if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
  }
  return texts.join('\n')
}

function responsesInputText(body: Record<string, unknown>): string {
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : []
  const texts: string[] = []
  for (const item of input) {
    const c = item.content
    if (typeof c === 'string') texts.push(c)
    else if (Array.isArray(c)) for (const b of c as Array<{ type?: string; text?: string }>) if (typeof b.text === 'string') texts.push(b.text)
  }
  return texts.join('\n')
}

const isSummaryRequest = (text: string): boolean => text.includes('Produce the analysis and summary now')

function anthropicReply(res: ServerResponse, text: string, usage: { input: number; output: number }, n: number): void {
  const usageBlock = { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(evt('message_start', { type: 'message_start', message: { id: `msg_fx_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null, usage: { ...usageBlock, output_tokens: 1 } } }))
  res.write(evt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.write(evt('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usageBlock }))
  res.end(evt('message_stop', { type: 'message_stop' }))
}

function responsesReply(res: ServerResponse, text: string, inputTokens: number, n: number): void {
  const rid = `resp_fx_${n}`
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse({ type: 'response.created', response: { id: rid } }))
  res.write(sse({ type: 'response.output_text.delta', delta: text }))
  res.write(sse({ type: 'response.output_item.done', item: { type: 'message', id: `msg_${n}`, role: 'assistant', content: [{ type: 'output_text', text }] } }))
  res.end(sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: inputTokens, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } }))
}

let calls = 0
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = (req.url ?? '').split('?')[0] ?? ''
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      body = {}
    }
    if (req.method === 'GET' && url.endsWith('/models')) {
      record({ kind: 'models', url, at: Date.now() })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'gpt-5.6-sol',
              display_name: 'GPT-5.6 Sol',
              supported_reasoning_levels: ['low', 'medium', 'high'],
              default_reasoning_level: 'medium',
              visibility: 'public',
              supported_in_api: true,
              priority: 1,
              context_window: WINDOW,
              ...(CEILING > WINDOW ? { max_context_window: CEILING } : {}),
              input_modalities: ['text', 'image'],
            },
          ],
        }),
      )
      return
    }
    if (req.method === 'POST' && url.endsWith('/responses')) {
      const n = ++calls
      const text = responsesInputText(body)
      const count = Math.round(raw.length / CHARS_PER_TOKEN)
      const summary = isSummaryRequest(text)
      const refused = count > WINDOW
      record({ kind: 'openai', n, url, at: Date.now(), model: body.model, count, summary, refused, tools: Array.isArray(body.tools) ? body.tools.length : 0, ask: text.slice(-80) })
      if (refused) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: OVERFLOW_SENTENCE, type: 'invalid_request_error', param: 'input', code: 'context_length_exceeded' } }))
        return
      }
      responsesReply(res, summary ? GPT_SUMMARY : GPT_REPLY, count, n)
      return
    }
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      const n = ++calls
      const text = anthropicText(body)
      const count = Math.round(raw.length / CHARS_PER_TOKEN)
      const summary = isSummaryRequest(text)
      const big = text.includes(BIG_ASK) && !summary && !text.includes(BIG_REPLY_TAIL)
      record({ kind: 'anthropic', n, url, at: Date.now(), model: body.model, count, summary, big, tools: Array.isArray(body.tools) ? body.tools.length : 0, ask: text.slice(-80) })
      if (summary) return anthropicReply(res, OPUS_SUMMARY, { input: count, output: 20 }, n)
      if (big) {
        const reply = bigReplyText()
        return anthropicReply(res, reply, { input: count, output: Math.round(reply.length / CHARS_PER_TOKEN) }, n)
      }
      const tools = Array.isArray(body.tools) ? body.tools.length : 0
      return anthropicReply(res, tools === 0 ? 'svc' : `heard: ${text.split('\n').pop() ?? ''} (#${n})`, { input: count, output: 6 }, n)
    }
    record({ kind: 'hit', method: req.method, url, at: Date.now() })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  console.log(`PORT ${port}`)
})

const shutdown = (): void => {
  server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
const parentPid = process.ppid
setInterval(() => {
  try {
    process.kill(parentPid, 0)
  } catch {
    shutdown()
  }
}, 1000).unref()
