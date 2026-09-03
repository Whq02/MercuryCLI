#!/usr/bin/env node
// ============================================================================
//  scripts/daemon/first-byte-fixture-server.ts — the Anthropic loopback for
//  prove-first-byte-drive.ts, run as its OWN process under NODE (bun's
//  node:http shim never raises the close a mid-stream drop causes; node
//  strips this file's type annotations natively).
//
//  The arms, keyed by the ask in the request's last user row:
//    · "ingest slowly"    — the cold-ingest arm: the response HEADERS are
//                           held for FIXTURE_HOLD_MS (default 6000), then a
//                           full reply streams ("slow answer arrived")
//    · "never answer"     — the abort arm: the request is held open with no
//                           byte until the client drops it (recorded)
//    · "overloaded twice" — the reissue arm: the first two such requests
//                           answer 529 overloaded; the third streams
//                           ("third time lucky")
//    · anything else      — a canned reply at once ("fixture answers")
//  Every request, held header, drop and answer lands in the capture file
//  (argv[2]) as one JSON line with an epoch stamp.
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: first-byte-fixture-server.ts <captureFile>')
  process.exit(2)
}
const HOLD_MS = Number.parseInt(process.env.FIXTURE_HOLD_MS ?? '6000', 10)

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify({ ...entry, at: Date.now() })}\n`)
}
function reply(model: string, text: string): string {
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_fx_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
function askOf(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []
  const last = [...messages].reverse().find(m => m.role === 'user')
  return last === undefined ? '' : JSON.stringify(last.content ?? '')
}

let overloadedSeen = 0
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // The drop listeners arm before the body is consumed (node keeps them
  // live; the socket's close is the drop).
  let dropped = false
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = (req.url ?? '').split('?')[0] ?? ''
    const body = ((): Record<string, unknown> => {
      try {
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        return {}
      }
    })()
    if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
      record({ kind: 'hit', method: req.method, url })
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const ask = askOf(body)
    const model = String(body.model ?? '')
    const arm = ask.includes('never answer') ? 'never' : ask.includes('ingest slowly') ? 'slow' : ask.includes('overloaded twice') ? 'overloaded' : 'canned'
    record({ kind: 'anthropic', arm, model, tools: Array.isArray(body.tools) ? (body.tools as unknown[]).length : 0 })
    req.socket.on('close', () => {
      if (!res.writableEnded) {
        dropped = true
        record({ kind: 'client-dropped', arm, model })
      }
    })
    if (arm === 'never') {
      record({ kind: 'held', arm })
      return
    }
    if (arm === 'slow') {
      record({ kind: 'held', arm, holdMs: HOLD_MS })
      setTimeout(() => {
        if (dropped || res.writableEnded) return
        record({ kind: 'headers-sent', arm, model })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(reply(model, 'slow answer arrived'))
      }, HOLD_MS)
      return
    }
    if (arm === 'overloaded') {
      overloadedSeen++
      if (overloadedSeen <= 2) {
        record({ kind: 'answered', arm, status: 529, nth: overloadedSeen })
        res.writeHead(529, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
        return
      }
      record({ kind: 'answered', arm, status: 200, nth: overloadedSeen })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(reply(model, 'third time lucky'))
      return
    }
    record({ kind: 'answered', arm, status: 200 })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(reply(model, 'fixture answers'))
  })
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  console.log(`PORT ${port}`)
})
