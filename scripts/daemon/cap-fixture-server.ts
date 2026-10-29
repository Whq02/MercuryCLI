#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'
import { ANTHROPIC_REPLY, GPT_ID, HOLD_ASK, OPENAI_REPLY, RESET_IN_SECONDS, SPEND_ASK } from './cap-fixture-words.ts'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: cap-fixture-server.ts <captureFile>')
  process.exit(2)
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const named = (event: string, obj: unknown): string => `event: ${event}\n${sse(obj)}`

function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}

function lastAskOf(body: Record<string, unknown>): string {
  const rows = Array.isArray(body.messages)
    ? (body.messages as Array<{ role?: string; content?: unknown }>)
    : Array.isArray(body.input)
      ? (body.input as Array<{ role?: string; content?: unknown }>)
      : []
  const last = [...rows].reverse().find(m => m.role === 'user')
  if (last === undefined) return typeof body.input === 'string' ? body.input : ''
  const content = last.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts = content
    .map(b => (b !== null && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : null))
    .filter((t): t is string => t !== null && !t.startsWith('<'))
  return texts.length === 0 ? '' : texts[texts.length - 1]!
}

function anthropicReply(model: string): string {
  const usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
  return [
    named('message_start', { type: 'message_start', message: { id: `msg_cap_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }),
    named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANTHROPIC_REPLY } }),
    named('content_block_stop', { type: 'content_block_stop', index: 0 }),
    named('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...usage, output_tokens: 8 } }),
    named('message_stop', { type: 'message_stop' }),
  ].join('')
}

function responsesReply(): string {
  const rid = `resp_cap_${Date.now()}`
  return [
    sse({ type: 'response.created', response: { id: rid } }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: OPENAI_REPLY }] } }),
    sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 12, output_tokens: 6 } } }),
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
    if (req.method === 'GET' && url.endsWith('/models')) {
      record({ kind: 'models', url, at: Date.now() })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          models: [
            {
              slug: GPT_ID,
              display_name: 'GPT-5.6 Sol',
              supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({ effort, description: effort })),
              default_reasoning_level: 'high',
              visibility: 'list',
              priority: 1,
              context_window: 400_000,
              input_modalities: ['text', 'image'],
              supported_in_api: true,
            },
          ],
        }),
      )
      return
    }
    if (req.method === 'POST' && url.endsWith('/responses')) {
      const ask = lastAskOf(body)
      if (ask.includes(SPEND_ASK)) {
        record({ kind: 'openai', ask: ask.slice(0, 80), model, status: 429, at: Date.now() })
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'You have hit your usage limit.', resets_in_seconds: RESET_IN_SECONDS, plan_type: 'plus' } }))
        return
      }
      if (ask.includes(HOLD_ASK)) {
        record({ kind: 'openai', ask: ask.slice(0, 80), model, status: 'held', at: Date.now() })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(sse({ type: 'response.created', response: { id: `resp_hold_${Date.now()}` } }))
        return
      }
      record({ kind: 'openai', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesReply())
      return
    }
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      const ask = lastAskOf(body)
      if (ask.includes(SPEND_ASK)) {
        record({ kind: 'anthropic', ask: ask.slice(0, 80), model, status: 429, at: Date.now() })
        const resetAt = Math.floor(Date.now() / 1000) + RESET_IN_SECONDS
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
          'retry-after': String(RESET_IN_SECONDS),
          'x-should-retry': 'false',
        })
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "This request would exceed your account's rate limit." } }))
        return
      }
      if (ask.includes(HOLD_ASK)) {
        record({ kind: 'anthropic', ask: ask.slice(0, 80), model, status: 'held', at: Date.now() })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(named('message_start', { type: 'message_start', message: { id: `msg_hold_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }))
        return
      }
      record({ kind: 'anthropic', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicReply(model))
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
