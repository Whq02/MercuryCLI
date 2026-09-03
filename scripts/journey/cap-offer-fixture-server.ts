#!/usr/bin/env node
// ============================================================================
//  scripts/journey/cap-offer-fixture-server.ts — the two-family loopback for
//  prove-cap-offer-live.ts, run as its OWN process under NODE.
//
//  Why a separate process: a PTY-driven child cannot connect back into a
//  server socket held by the prover process under the harness sandbox. Why
//  node: bun's http shim never raises close on a mid-stream drop, so the
//  journey fixtures are hosted under the runtime the product ships.
//
//  What it serves:
//    · GET  …/models        — the OpenAI catalogue (gpt-5.6-sol), for the
//                             ChatGPT-subscription base AND the API base
//    · POST …/responses     — a Responses SSE reply carrying the x-codex
//                             usage bands: the 5h window NEAR ITS CAP, and on
//                             every later call the same wall re-observed with
//                             its stated reset shifted by seconds (the jitter
//                             the offer's armed state must survive)
//    · POST …/v1/messages   — an Anthropic SSE reply (the handoff target)
//  Every hit lands in the JSONL capture file passed as argv[2].
//
//  argv: [script, captureFile]
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: cap-offer-fixture-server.ts <captureFile>')
  process.exit(2)
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
// Contract data shared with prove-cap-offer-live.ts (kept in both files — the
// server cannot be imported without starting it).
const GPT_REPLY = 'sol answers from the fixture'
const GPT_REPLY_AGAIN = 'sol answers again from the fixture'
const FABLE_REPLY = 'fable picked up the handoff'
const ZAI_REPLY = 'glm picked up the handoff'
const DEEPSEEK_REPLY = 'deepseek picked up the handoff'

/** The OpenAI-compatible chat stream the key lanes read: content deltas,
 *  a final chunk with finish_reason, the [DONE] sentinel. */
function chatCompletionsSse(text: string): string {
  const id = `chatcmpl_fx_${Date.now()}`
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    sse({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })
  return [
    chunk({ role: 'assistant', content: '' }, null),
    chunk({ content: text }, null),
    chunk({}, 'stop'),
    'data: [DONE]\n\n',
  ].join('')
}

function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}

let responsesCalls = 0

function responsesSse(text: string): string {
  const rid = `resp_fx_${Date.now()}_${responsesCalls}`
  return [
    sse({ type: 'response.created', response: { id: rid } }),
    sse({
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    }),
    sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 12, output_tokens: 6 } } }),
  ].join('')
}
function anthropicSse(): string {
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'claude-fable-5-1', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: FABLE_REPLY } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}

/** The OpenAI 5h window NEAR ITS CAP, as the subscription wire states it: the
 *  first answer at 92% with an hour to the reset; every later answer the SAME
 *  wall re-observed — a point up, the stated reset a few seconds nearer (the
 *  header is a countdown the client re-anchors on its own clock). */
function usageHeaders(call: number): Record<string, string> {
  const first = call === 1
  return {
    'x-codex-primary-used-percent': first ? '92' : '93',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-after-seconds': first ? '3600' : '3595',
    'x-codex-secondary-used-percent': '41',
    'x-codex-secondary-window-minutes': '10080',
    'x-codex-secondary-reset-after-seconds': '400000',
  }
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
      responsesCalls += 1
      record({ kind: 'openai', url, body, call: responsesCalls, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream', ...usageHeaders(responsesCalls) })
      res.end(responsesSse(responsesCalls === 1 ? GPT_REPLY : GPT_REPLY_AGAIN))
      return
    }
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      record({ kind: 'anthropic', url, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicSse())
      return
    }
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      // The key lanes' OpenAI-compatible wire (Z.AI · DeepSeek): the base
      // pins name the lane in the path, so the reply names the lane.
      const lane = url.includes('/zai/') ? 'zai' : url.includes('/deepseek/') ? 'deepseek' : 'compat'
      record({ kind: lane, url, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatCompletionsSse(lane === 'zai' ? ZAI_REPLY : DEEPSEEK_REPLY))
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
