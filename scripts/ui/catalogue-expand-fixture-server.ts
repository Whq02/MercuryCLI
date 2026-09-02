#!/usr/bin/env bun
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const ledger = process.argv[2] ?? ''

export const NEEDLE_INDEX = 27

const OPENROUTER_BODY = JSON.stringify({
  data: Array.from({ length: 30 }, (_, i) =>
    i === NEEDLE_INDEX
      ? { id: 'deepvendor/needle-model', name: 'Needle Model', context_length: 131_072, created: 1_755_800_000 + i }
      : { id: `fixture-vendor/expand-model-${i}`, name: `Expand Model ${i}`, context_length: 32_000 + i, created: 1_755_800_000 + i },
  ),
  total_count: 30,
  links: { next: null },
})

const OPENROUTER_KEY_BODY = JSON.stringify({ data: { label: 'fixture', usage: 0, limit: null, limit_remaining: null, is_free_tier: false } })

const HUGGINGFACE_BODY = JSON.stringify({
  object: 'list',
  data: Array.from({ length: 30 }, (_, i) =>
    i === NEEDLE_INDEX
      ? {
          id: 'deeporg/needle-model',
          object: 'model',
          created: 1_755_800_000 + i,
          owned_by: 'deeporg',
          providers: [{ provider: 'novita', status: 'live', context_length: 131_072, supports_tools: true }],
        }
      : {
          id: `fixture-org/expand-model-${i}`,
          object: 'model',
          created: 1_755_800_000 + i,
          owned_by: 'fixture-org',
          providers: [{ provider: 'novita', status: 'live', context_length: 32_000 + i, supports_tools: true }],
        },
  ),
})

const server = createServer((req, res) => {
  if (ledger) {
    try {
      appendFileSync(ledger, `${new Date().toISOString()} ${req.method} ${req.url}\n`)
    } catch {
    }
  }
  const path = (req.url ?? '').split('?')[0] ?? ''
  const answer = (status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  }
  if (path === '/or/v1/models') answer(200, OPENROUTER_BODY)
  else if (path === '/or/v1/key') answer(200, OPENROUTER_KEY_BODY)
  else if (path === '/hf/v1/models') answer(200, HUGGINGFACE_BODY)
  else answer(404, '{}')
})

function listen(port: number): void {
  server.once('error', () => {
    if (port < 34999) listen(port + 1)
    else {
      console.error('no free port in 34900-34999')
      process.exit(2)
    }
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`PORT ${port}`)
  })
}
listen(34900)
