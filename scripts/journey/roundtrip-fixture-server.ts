#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/roundtrip-fixture-server.ts — the two-dialect backend for
//  prove-concourse-roundtrip-transcript.ts, run as its OWN process (a PTY
//  child cannot reach a prover-held loopback under the sandbox).
//
//  Anthropic dialect (POST */v1/messages):
//    · a haiku-model body (utility one-shots: titles, recaps) → a tiny
//      'svc' reply;
//    · anything else → the SLOW alpha turn: paced text deltas carrying
//      SIGMA-ALPHA-7 … ALPHA-TAIL-DONE across ~5s, so a /model switch can
//      QUEUE mid-turn (the operator's exact shape).
//  OpenAI Responses dialect (GET */models · POST */responses):
//    · the gpt-5.6-sol catalogue row; the terra turn answers
//      SIGMA-TERRA-9 (the cross-provider reply whose survival is on trial).
//
//  argv: [captureFile]. Prints `PORT <n>` when listening.
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'

const captureFile = process.argv[2]
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const named = (event: string, obj: unknown): string => `event: ${event}\n${sse(obj)}`

function record(entry: Record<string, unknown>): void {
  if (!captureFile) return
  try {
    appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
  } catch {
    /* forensics only */
  }
}

const ALPHA_CHUNKS = [
  'SIGMA-ALPHA-7 opens the alpha reply. ',
  'The alpha body keeps arriving in slow measured steps ',
  'so a queued model switch has a real mid-turn window. ',
  'More alpha prose rides here to stretch the stream ',
  'past the switch keystrokes and their receipt. ',
  'ALPHA-TAIL-DONE closes the alpha reply.',
]
const TERRA_TEXT =
  'SIGMA-TERRA-9 opens the terra reply on the OpenAI lane; its survival across the concourse round trip is the law under trial.'

async function alphaTurn(res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(
    named('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_alpha',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
      },
    }),
  )
  res.write(named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  for (const chunk of ALPHA_CHUNKS) {
    await new Promise(r => setTimeout(r, 800))
    res.write(named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }))
  }
  res.write(named('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(
    named('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 64 },
    }),
  )
  res.write(named('message_stop', { type: 'message_stop' }))
  res.end()
}

function svcTurn(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(
    [
      named('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_svc',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
        },
      }),
      named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'svc' } }),
      named('content_block_stop', { type: 'content_block_stop', index: 0 }),
      named('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
      named('message_stop', { type: 'message_stop' }),
    ].join(''),
  )
}

function terraTurn(res: ServerResponse): void {
  const rid = `resp_terra_${Date.now()}`
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(
    [
      sse({ type: 'response.created', response: { id: rid } }),
      sse({
        type: 'response.output_item.done',
        item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: TERRA_TEXT }] },
      }),
      sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 30, output_tokens: 24 } } }),
    ].join(''),
  )
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
    if (req.method === 'GET' && url.endsWith('/models')) {
      record({ kind: 'models', at: Date.now() })
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
              input_modalities: ['text'],
            },
          ],
        }),
      )
      return
    }
    if (req.method === 'POST' && url.endsWith('/responses')) {
      record({ kind: 'openai', model: body.model, at: Date.now() })
      terraTurn(res)
      return
    }
    if (req.method === 'POST' && url.endsWith('/messages')) {
      const model = String(body.model ?? '')
      record({ kind: 'anthropic', model, at: Date.now() })
      if (model.includes('haiku')) svcTurn(res)
      else void alphaTurn(res)
      return
    }
    record({ kind: 'hit', method: req.method, url, at: Date.now() })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  console.log(`PORT ${typeof address === 'object' && address ? address.port : 0}`)
})
