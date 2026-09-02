#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/noping-fixture-server.ts — the MINIMAL Anthropic-dialect
//  SSE fixture from a driven study:
//  message_start → content_block_start → text deltas → content_block_stop →
//  message_delta → message_stop. NO ping events, NO cache/service usage
//  fields — exactly the gaps sloppy "Anthropic-compatible" endpoints ship.
//  Runs as its OWN process (in-prover loopbacks are unreachable from spawned
//  PTY children under the sandbox).
//
//  argv: [captureFile]   env: FIXTURE_PORT (required) · FIXTURE_TPS ·
//  FIXTURE_TTFB_MS. Prints `PORT <n>` on stdout when listening.
// ============================================================================
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.FIXTURE_PORT ?? '0')
const TPS = Number(process.env.FIXTURE_TPS ?? '40')
const TTFB_MS = Number(process.env.FIXTURE_TTFB_MS ?? '350')
const captureFile = process.argv[2]

// The driven study's canonical document (rig/fixture-server.mjs) — long
// enough that the paint throttle has real work; ends in a distinctive line
// the prover awaits.
const DOC = `# Plan: tighten the parser

The tokenizer currently allocates one buffer per line. Under streaming load that
is the dominant cost. We can hold a single scratch buffer and reuse it across
lines, resetting the write head instead of reallocating.

Three steps get us there safely:

- Measure the baseline with the existing corpus so the win is provable.
- Introduce the scratch buffer behind a flag and mirror writes to both paths.
- Flip the flag once the mirror diff stays empty for a full corpus run.

The corpus results before and after:

| Corpus | Before | After | Delta |
| ------ | ------ | ----- | ----- |
| small  | 41ms   | 39ms  | -5%   |
| medium | 210ms  | 168ms | -20%  |
| large  | 1.9s   | 1.3s  | -32%  |
| mixed  | 640ms  | 501ms | -22%  |

The large-corpus win comes almost entirely from allocation pressure: the old
path triggered a collection roughly every four hundred lines, and the new one
completes the whole corpus inside a single young generation.

Rollout is a one-line flag flip, and the mirror stays in the tree for one more
release so a regression report can re-arm it instantly.
`

function chunkDoc(doc: string): string[] {
  const parts = doc.split(/(?<=\s)/)
  const chunks: string[] = []
  let i = 0
  let take = 1
  while (i < parts.length) {
    chunks.push(parts.slice(i, i + take).join(''))
    i += take
    take = (take % 3) + 1
  }
  return chunks
}
const CHUNKS = chunkDoc(DOC)

function sseNamed(res: http.ServerResponse, event: string, obj: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function streamAnthropic(res: http.ServerResponse): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  await sleep(TTFB_MS)
  // Sparse usage by design: no cache fields, no service tier — the D3 shape.
  sseNamed(res, 'message_start', {
    type: 'message_start',
    message: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 1 },
    },
  })
  sseNamed(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })
  const interval = 1000 / TPS
  for (const c of CHUNKS) {
    await sleep(interval)
    sseNamed(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: c },
    })
  }
  sseNamed(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  sseNamed(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: CHUNKS.length },
  })
  sseNamed(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', d => (body += String(d)))
  req.on('end', () => {
    if (captureFile) {
      try {
        appendFileSync(captureFile, `${JSON.stringify({ url: req.url, at: Date.now(), bytes: body.length, body })}\n`)
      } catch {
        /* forensics only */
      }
    }
    void (async () => {
      try {
        if (req.method === 'POST' && (req.url ?? '').includes('/messages')) {
          await streamAnthropic(res)
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: `no fixture route for ${req.method} ${req.url}` } }))
      } catch {
        try {
          res.destroy()
        } catch {
          /* gone */
        }
      }
    })()
  })
})
server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address()
  console.log(`PORT ${typeof addr === 'object' && addr !== null ? addr.port : PORT}`)
})
