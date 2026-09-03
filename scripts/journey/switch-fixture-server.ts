#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/switch-fixture-server.ts — the two-family loopback for
//  prove-switch-pickup-live.ts, run as its OWN process.
//
//  Why a separate process: a PTY-driven child cannot connect back into a
//  server socket held by the prover process under the harness sandbox
//  (live-found triage: node-under-bun → in-prover server times out at
//  connect; the same server in its own process accepts instantly). The
//  prover spawns this server, reads `PORT <n>` from stdout, and reads the
//  wire captures from the JSONL file passed as argv[2].
//
//  argv: [script, captureFile]
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: switch-fixture-server.ts <captureFile>')
  process.exit(2)
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
export const GPT_REPLY = 'sol answers from the fixture'
export const OPUS_REPLY = 'opus picked up cleanly'
/** The ask that opens the never-ending thinking phase (the interrupt
 *  drive's request); any other ask gets the canned reply. */
export const LONG_THINK_ASK = 'think long please'
const LONG_THINK_CEILING_MS = 120_000

/** The MAIN turn's ask is the last user row's text (a tool-bearing
 *  request); side calls (a title, a validation probe) never carry it. */
function wantsLongThink(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []
  const last = [...messages].reverse().find(m => m.role === 'user')
  return last !== undefined && JSON.stringify(last.content ?? '').includes(LONG_THINK_ASK)
}

function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}

function responsesSse(): string {
  const rid = `resp_fx_${Date.now()}`
  return [
    sse({ type: 'response.created', response: { id: rid } }),
    sse({
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: GPT_REPLY }] },
    }),
    sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 12, output_tokens: 6 } } }),
  ].join('')
}
function anthropicSse(): string {
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: OPUS_REPLY } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // THE DROP LISTENERS arm BEFORE the body is consumed: once the request
  // has ended, bun's node:http shim detaches it from its socket and a
  // listener added later hears nothing. The socket's close and the
  // request's 'aborted' are the drop signals both runtimes raise; the
  // response's close is node's alone.
  const dropListeners: Array<() => void> = []
  const dropped = (): void => {
    for (const listener of dropListeners.splice(0)) listener()
  }
  req.socket?.on('close', dropped)
  req.on('aborted', dropped)
  res.on('close', dropped)
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
    if (req.method === 'GET' && url.endsWith('/models')) {
      record({ kind: 'hit', method: req.method, url, at: Date.now() })
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
              context_window: 400_000,
              input_modalities: ['text', 'image'],
            },
          ],
        }),
      )
      return
    }
    if (req.method === 'POST' && url.endsWith('/responses')) {
      record({ kind: 'openai', url, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesSse())
      return
    }
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      record({ kind: 'anthropic', url, body, at: Date.now() })
      if (wantsLongThink(body)) {
        // THE LONG THINKING PHASE (the interrupt drive): a thinking block
        // that streams a delta every 250 ms and never ends on its own — the
        // request the operator's esc must tear down. The socket's close is
        // the one fact the drive reads: `anthropic-closed` stamps when the
        // client dropped the connection (an abort) or, past the ceiling,
        // when the stream ended honestly on its own.
        const openedAt = Date.now()
        record({ kind: 'anthropic-open', at: openedAt })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(
          `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx_think', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
        )
        res.write(`event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}`)
        let n = 0
        const timer = setInterval(() => {
          if (res.writableEnded || res.destroyed) return
          res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `pondering ${++n} ` } })}`)
        }, 250)
        let closed = false
        const onClose = (why: string): void => {
          if (closed) return
          closed = true
          clearInterval(timer)
          record({ kind: 'anthropic-closed', at: Date.now(), openMs: Date.now() - openedAt, why })
        }
        // The drop listeners armed at the request's start (see the handler's
        // head) fire here: a drop while the stream is open is the client's
        // abort; after the ceiling's end it is the ordinary close.
        dropListeners.push(() => onClose(res.writableEnded ? 'ended' : 'client-dropped'))
        setTimeout(() => {
          if (!res.writableEnded && !res.destroyed) res.end()
        }, LONG_THINK_CEILING_MS).unref()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicSse())
      return
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
