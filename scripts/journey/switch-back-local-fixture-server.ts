#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: switch-back-local-fixture-server.ts <captureFile> [numCtx] [noteChars] [heldNote] [holdMs]')
  process.exit(2)
}
const NUM_CTX = Number.parseInt(process.argv[3] ?? '32768', 10)
const NOTE_CHARS = Number.parseInt(process.argv[4] ?? '16000', 10)
const HELD_NOTE = Number.parseInt(process.argv[5] ?? '0', 10)
const HOLD_MS = Number.parseInt(process.argv[6] ?? '0', 10)
const LOCAL_TAG = 'qwen3.8-27b-32k:latest'
const NOTE_ASK = 'write design note'
const PICKUP_ASK = 'carry on from the notes'
const LOCAL_REPLY = 'the local model carries on from the notes'
const OPUS_SUMMARY = 'SUMMARY BY OPUS: the design notes were written one by one and the operator asked to carry on from them on the local model.'

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const evt = (name: string, obj: unknown): string => `event: ${name}\n${sse(obj)}`
function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function noteText(n: number): string {
  let out = ''
  for (let line = 0; out.length < NOTE_CHARS; line++) {
    const reference = createHash('sha256').update(`switch-back-note-${n}-line-${line}`).digest('hex')
    out += `Note ${n}, section ${line} records a module boundary: ${reference}. Check the indexed observations before changing it.\n`
  }
  return `${out}\ndesign note ${n} ends here`
}

function textOf(body: Record<string, unknown>, role: 'user' | 'assistant'): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []
  const texts: string[] = []
  for (const m of messages) {
    if (m.role !== role) continue
    const c = m.content
    if (typeof c === 'string') texts.push(c)
    else if (Array.isArray(c)) for (const b of c as Array<{ type?: string; text?: string }>) if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
  }
  return texts.join('\n')
}
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1

function anthropicReply(res: ServerResponse, text: string, usage: { input: number; output: number }, n: number, held?: { opening: string; ms: number }): void {
  const usageBlock = { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(evt('message_start', { type: 'message_start', message: { id: `msg_fx_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null, usage: { ...usageBlock, output_tokens: 1 } } }))
  res.write(evt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  const finish = (): void => {
    res.write(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
    res.write(evt('content_block_stop', { type: 'content_block_stop', index: 0 }))
    res.write(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usageBlock }))
    res.end(evt('message_stop', { type: 'message_stop' }))
  }
  if (held === undefined) return finish()
  res.write(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: held.opening } }))
  setTimeout(() => {
    record({ kind: 'released', n, at: Date.now() })
    finish()
  }, held.ms)
}

let calls = 0
let loadedCtx: number | undefined
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
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      const n = ++calls
      const text = textOf(body, 'user')
      const count = Math.round(raw.length / 4)
      const summary = text.includes('Produce the summary now')
      const tools = Array.isArray(body.tools) ? body.tools.length : 0
      const written = occurrences(textOf(body, 'assistant'), ' ends here')
      const wantsNote = !summary && tools > 0 && occurrences(text, NOTE_ASK) > written
      record({ kind: 'anthropic', n, at: Date.now(), model: body.model, count, summary, note: wantsNote, tools })
      if (summary) return anthropicReply(res, OPUS_SUMMARY, { input: count, output: 30 }, n)
      if (wantsNote) {
        const reply = noteText(written + 1)
        const held = written + 1 === HELD_NOTE && HOLD_MS > 0 ? { opening: `design note ${written + 1} begins here\n\n`, ms: HOLD_MS } : undefined
        return anthropicReply(res, reply, { input: count, output: Math.round(reply.length / 4) }, n, held)
      }
      return anthropicReply(res, tools === 0 ? 'svc' : 'heard', { input: count, output: 6 }, n)
    }
    if (url === '/api/tags') return json(res, 200, { models: [{ name: LOCAL_TAG, model: LOCAL_TAG, size: 17741872134, details: { family: 'qwen35', parameter_size: '27.3B', quantization_level: 'Q4_K_M' } }] })
    if (url === '/api/version') return json(res, 200, { version: '0.40.5' })
    if (url === '/api/ps') return json(res, 200, { models: loadedCtx === undefined ? [] : [{ name: LOCAL_TAG, model: LOCAL_TAG, size: 20734048992, size_vram: 20734048992, context_length: loadedCtx, expires_at: new Date(Date.now() + 240_000).toISOString() }] })
    if (url === '/api/show') return json(res, 200, { parameters: `temperature                    1\nnum_ctx                        ${NUM_CTX}`, model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 }, capabilities: ['completion', 'tools', 'thinking'], thinking: { values: [false, 'low', 'medium', 'xhigh'], default: 'medium' } })
    if (url === '/api/generate' && req.method === 'POST') {
      const options = body.options as { num_ctx?: number } | undefined
      loadedCtx = options?.num_ctx ?? NUM_CTX
      record({ kind: 'local-load', at: Date.now(), numCtx: options?.num_ctx })
      return json(res, 200, { model: body.model, response: '', done: true, done_reason: 'load' })
    }
    if (url === '/api/chat' && req.method === 'POST') {
      const n = ++calls
      const options = body.options as { num_ctx?: number; num_predict?: number } | undefined
      loadedCtx = options?.num_ctx ?? NUM_CTX
      const count = Math.round(raw.length / 4)
      record({ kind: 'local', n, at: Date.now(), numCtx: options?.num_ctx, numPredict: options?.num_predict, count, messages: Array.isArray(body.messages) ? body.messages.length : 0, tools: Array.isArray(body.tools) ? body.tools.length : 0, pickup: raw.includes(PICKUP_ASK), summary: raw.includes('Produce the summary now') })
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ model: LOCAL_TAG, created_at: new Date().toISOString(), message: { role: 'assistant', content: LOCAL_REPLY }, done: false })}\n`)
      res.end(`${JSON.stringify({ model: LOCAL_TAG, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: count, eval_count: 9 })}\n`)
      return
    }
    record({ kind: 'hit', method: req.method, url, at: Date.now() })
    json(res, 404, {})
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
