#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'
import { SEAT_REPLY_PREFIX, SEAT_SPEND_ASK } from './crew-seat-fixture-words.ts'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: crew-seat-fixture-server.ts <captureFile>')
  process.exit(2)
}
const RESET_SECONDS = Number.parseInt(process.env.FIXTURE_RESET_SECONDS ?? '8', 10)
const SPEND_ONCE = process.env.FIXTURE_SPEND_ONCE === '1'
let spent = 0

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const named = (event: string, obj: unknown): string => `event: ${event}\n${sse(obj)}`

function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}

type Row = { role?: string; content?: unknown }

function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .map(b => (b !== null && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : null))
    .filter((t): t is string => t !== null)
}

function asksOf(body: Record<string, unknown>): { asks: string[]; replies: string[]; last: string } {
  const rows = Array.isArray(body.messages) ? (body.messages as Row[]) : []
  const asks: string[] = []
  const replies: string[] = []
  for (const row of rows) {
    const texts = textsOf(row.content).filter(t => !t.startsWith('<'))
    if (row.role === 'user') asks.push(...texts)
    if (row.role === 'assistant') replies.push(...texts)
  }
  return { asks, replies, last: asks.length === 0 ? '' : asks[asks.length - 1]! }
}

function reply(model: string, text: string): string {
  const usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
  return [
    named('message_start', { type: 'message_start', message: { id: `msg_seat_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }),
    named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    named('content_block_stop', { type: 'content_block_stop', index: 0 }),
    named('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...usage, output_tokens: 8 } }),
    named('message_stop', { type: 'message_stop' }),
  ].join('')
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
    const model = String(body.model ?? '')
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      const { asks, replies, last } = asksOf(body)
      const spend = last.includes(SEAT_SPEND_ASK) && (!SPEND_ONCE || spent === 0)
      if (spend) {
        spent += 1
        const resetAt = Math.floor(Date.now() / 1000) + RESET_SECONDS
        record({ kind: 'anthropic', model, asks, replies, last, status: 429, resetAt: resetAt * 1000, at: Date.now() })
        res.writeHead(429, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
          'anthropic-ratelimit-unified-reset': String(resetAt),
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-utilization': '1.0',
          'anthropic-ratelimit-unified-5h-reset': String(resetAt),
          'anthropic-ratelimit-unified-overage-status': 'rejected',
          'anthropic-ratelimit-unified-overage-disabled-reason': 'overage_not_provisioned',
          'retry-after': String(RESET_SECONDS),
          'x-should-retry': 'false',
        })
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "This request would exceed your account's rate limit." } }))
        return
      }
      const text = `${SEAT_REPLY_PREFIX}${last.slice(-80)}`
      record({ kind: 'anthropic', model, asks, replies, last, status: 200, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(reply(model, text))
      return
    }
    record({ kind: 'other', url: `${req.method} ${url}`, at: Date.now() })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  process.stdout.write(`PORT ${port}\n`)
})
