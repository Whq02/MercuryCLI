#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'

const REPLY_DELAY_MS = (() => {
  const raw = process.env.MISSION_FIXTURE_REPLY_DELAY_MS
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 45_000
})()
const captureFile = process.argv[2]

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const anthropicSse = (text: string): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (captureFile) {
      try {
        let body: unknown = null
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
        }
        appendFileSync(captureFile, JSON.stringify({ path, at: Date.now(), body }) + '\n')
      } catch {
      }
    }
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      let echo = ''
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages?: Array<{ role?: string; content?: unknown }>
        }
        for (const message of body.messages ?? []) {
          if (message.role !== 'user') continue
          const content = message.content
          if (typeof content === 'string' && content.trim() !== '') echo = content
          else if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as { type?: string; text?: string }
              if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') echo = b.text
            }
          }
        }
      } catch {
      }
      const replyText = echo === '' ? 'working the standing goal' : `standing reply to [[${echo.slice(0, 60)}]]`
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(anthropicSse(replyText))
      }, REPLY_DELAY_MS)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  console.log(`PORT ${port}`)
})
