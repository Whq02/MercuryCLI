#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: throttle-fixture-server.ts <captureFile>')
  process.exit(2)
}
const READ_PATH = process.env.FIXTURE_READ_PATH ?? '/dev/null'
const SLOW_GAP_MS = Number.parseInt(process.env.FIXTURE_SLOW_GAP_MS ?? '800', 10)
const FALLBACK_HOLD_MS = Number.parseInt(process.env.FIXTURE_FALLBACK_HOLD_MS ?? '700', 10)

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify({ ...entry, at: Date.now() })}\n`)
}
const usageOf = (output: number): Record<string, number> => ({
  input_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: output,
})
function messageStart(model: string): string {
  return `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_fx_${Date.now()}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: usageOf(1) } })}`
}
function streamFrames(model: string, blocks: Block[]): string[] {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const frames: string[] = [messageStart(model)]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      frames.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    } else {
      frames.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_fx_${Date.now() % 100000}_${index}`, name: block.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  frames.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: usageOf(8) })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return frames
}
function jsonReply(model: string, blocks: Block[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const content = blocks.map((block, index) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'tool_use', id: `toolu_fx_${Date.now() % 100000}_${index}`, name: block.name, input: block.input },
  )
  return JSON.stringify({
    id: `msg_fx_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: usageOf(8),
  })
}
function refusal(res: ServerResponse, status: number, headers: Record<string, string>, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
const RATE_LIMITED = { type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your rate limit' } }
const OVERLOADED = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }

function readAsk(body: Record<string, unknown>): { marker: string; arm: string; toolResult: boolean } {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []
  let marker = ''
  let arm = ''
  let toolResult = false
  for (const m of messages) {
    if (m.role !== 'user') continue
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string }>) : []
    for (const block of blocks) {
      if (block.type === 'tool_result') toolResult = true
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      const hit = /throttle-(seat|run): ([a-z0-9-]+)/.exec(block.text)
      if (hit) {
        marker = hit[1]!
        arm = hit[2]!
      }
    }
  }
  return { marker, arm, toolResult }
}
function offersTool(body: Record<string, unknown>, name: string): boolean {
  const tools = body.tools
  return Array.isArray(tools) && tools.some(t => (t as { name?: string })?.name === name)
}

const seen = new Map<string, number>()
const bump = (key: string): number => {
  const n = (seen.get(key) ?? 0) + 1
  seen.set(key, n)
  return n
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
    const model = String(body.model ?? '')
    const streaming = body.stream === true
    const { marker, arm, toolResult } = readAsk(body)
    const route = marker === 'seat' ? 'seat' : marker === 'run' ? (toolResult ? 'parent-ack' : 'parent') : 'side'
    const nth = bump(`${route}:${arm}:${toolResult ? 'after-tool' : 'first'}:${streaming ? 'stream' : 'json'}`)
    record({ kind: 'request', route, arm, streaming, toolResult, nth, model, agentToolListed: offersTool(body, 'Agent') })
    req.socket.on('close', () => {
      if (!res.writableEnded) {
        dropped = true
        record({ kind: 'client-dropped', route, arm, streaming, nth })
      }
    })
    const answer = (blocks: Block[]): void => {
      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(streamFrames(model, blocks).join(''))
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(jsonReply(model, blocks))
      }
      record({ kind: 'answered', route, arm, status: 200, streaming, nth })
    }

    if (route === 'parent') {
      answer([{ type: 'tool_use', name: 'Agent', input: { description: `throttle seat ${arm}`, prompt: `throttle-seat: ${arm}`, subagent_type: 'mercury-general' } }])
      return
    }
    if (route === 'parent-ack') {
      answer([{ type: 'text', text: 'parent done' }])
      return
    }
    if (route === 'side') {
      answer([{ type: 'text', text: 'fixture answers' }])
      return
    }
    if (arm === '429-retry-after') {
      record({ kind: 'answered', route, arm, status: 429, retryAfter: 2, nth })
      refusal(res, 429, { 'retry-after': '2' }, RATE_LIMITED)
      return
    }
    if (arm === '429-bare') {
      record({ kind: 'answered', route, arm, status: 429, nth })
      refusal(res, 429, {}, RATE_LIMITED)
      return
    }
    if (arm === '529') {
      record({ kind: 'answered', route, arm, status: 529, nth })
      refusal(res, 529, {}, OVERLOADED)
      return
    }
    if (arm === 'slow') {
      const frames = [
        messageStart(model),
        `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
        ...['slow ', 'but ', 'alive'].map(text => `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`),
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
        `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usageOf(8) })}`,
        `event: message_stop\n${sse({ type: 'message_stop' })}`,
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      record({ kind: 'headers-sent', route, arm, nth })
      let i = 0
      const tick = (): void => {
        if (dropped || res.writableEnded) return
        res.write(frames[i]!)
        i++
        if (i < frames.length) setTimeout(tick, SLOW_GAP_MS)
        else {
          res.end()
          record({ kind: 'answered', route, arm, status: 200, streaming: true, nth })
        }
      }
      tick()
      return
    }
    if (arm === 'quiet' || arm === 'drop') {
      if (toolResult) {
        if (nth === 1 && streaming) {
          record({ kind: 'answered', route, arm, status: 429, retryAfter: 1, nth, phase: 'after-tool' })
          refusal(res, 429, { 'retry-after': '1' }, RATE_LIMITED)
          return
        }
        answer([{ type: 'text', text: 'recovered after busy' }])
        return
      }
      if (!streaming) {
        record({ kind: 'fallback-held', route, arm, nth, holdMs: FALLBACK_HOLD_MS })
        setTimeout(() => {
          if (dropped || res.writableEnded) return
          answer([{ type: 'tool_use', name: 'Read', input: { file_path: READ_PATH } }])
        }, FALLBACK_HOLD_MS)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (arm === 'drop') {
        res.write(messageStart(model))
        record({ kind: 'dropped-by-fixture', route, arm, nth })
        setTimeout(() => res.socket?.destroy(), 20)
        return
      }
      res.flushHeaders()
      record({ kind: 'held', route, arm, nth })
      return
    }
    answer([{ type: 'text', text: `unknown arm ${arm}` }])
  })
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  console.log(`PORT ${port}`)
})
