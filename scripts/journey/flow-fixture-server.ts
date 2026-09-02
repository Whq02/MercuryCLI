#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/flow-fixture-server.ts — the scripted GPT backend for
//  prove-flow-neverstop-live.ts, run as its OWN process (a PTY child cannot
//  connect into a prover-held server under the harness sandbox — see
//  switch-fixture-server.ts).
//
//  The script (per POST /responses, in order):
//    call 1 → TWO grouped Read function_calls (README.md + NOTES.md)
//    call 2 → ONE repeat Read of README.md (the dedup front-door answers
//             the file-unchanged stub — delivery of the stub is on trial)
//    call 3 → the final text turn (the never-stop proof: the model saw all
//             three results and finished its task)
//
//  argv: [script, captureFile, fixtureCwd]
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const captureFile = process.argv[2]
const fixtureCwd = process.argv[3]
if (!captureFile || !fixtureCwd) {
  console.error('usage: flow-fixture-server.ts <captureFile> <fixtureCwd>')
  process.exit(2)
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const FINAL_TEXT = 'flow finished: both files read, repeat served from context'

function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}

const functionCallTurn = (calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): string => {
  const rid = `resp_flow_${Date.now()}`
  return [
    sse({ type: 'response.created', response: { id: rid } }),
    ...calls.map(c =>
      sse({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) },
      }),
    ),
    sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 15, output_tokens: 8 } } }),
  ].join('')
}
const textTurn = (text: string): string => {
  const rid = `resp_flow_${Date.now()}`
  return [
    sse({ type: 'response.created', response: { id: rid } }),
    sse({
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    }),
    sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 22, output_tokens: 9 } } }),
  ].join('')
}

let responsesCalls = 0
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
      responsesCalls++
      record({ kind: 'openai', n: responsesCalls, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (responsesCalls === 1) {
        res.end(
          functionCallTurn([
            { id: 'call_read_a', name: 'Read', args: { file_path: join(fixtureCwd, 'README.md') } },
            { id: 'call_read_b', name: 'Read', args: { file_path: join(fixtureCwd, 'NOTES.md') } },
          ]),
        )
      } else if (responsesCalls === 2) {
        res.end(
          functionCallTurn([
            { id: 'call_read_repeat', name: 'Read', args: { file_path: join(fixtureCwd, 'README.md') } },
          ]),
        )
      } else {
        res.end(textTurn(FINAL_TEXT))
      }
      return
    }
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      // Service side calls (title/topic) ride Anthropic even in a GPT
      // session — answer minimally so they settle.
      record({ kind: 'anthropic', body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        [
          `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_svc', type: 'message', role: 'assistant', model: 'claude-haiku', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
          `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
          `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'svc' } })}`,
          `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
          `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } })}`,
          `event: message_stop\n${sse({ type: 'message_stop' })}`,
        ].join(''),
      )
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
