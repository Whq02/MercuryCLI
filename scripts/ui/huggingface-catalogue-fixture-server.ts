#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/huggingface-catalogue-fixture-server.ts — a
//  loopback stand-in for the Hugging Face router catalogue, run as its OWN
//  process (a PTY-driven child cannot reach an in-prover listener).
//
//  Serves GET */models with a two-row wire-shaped answer and appends one
//  line per served request to the file named by argv[2] (the request-count
//  ledger the prover reads). argv[1] optionally delays each answer (ms).
//  Prints "PORT <n>" once listening; binds inside the proof range
//  34900-34999.
// ============================================================================
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const delayMs = Number(process.argv[2] ?? '0')
const ledger = process.argv[3] ?? ''

const BODY = JSON.stringify({
  object: 'list',
  data: [
    {
      id: 'catgate-org/catgate-fixture-model-a',
      object: 'model',
      created: 1_755_800_000,
      owned_by: 'catgate-org',
      providers: [
        { provider: 'novita', status: 'live', context_length: 131_072, supports_tools: true, pricing: { input: 0.5, output: 1.5 } },
      ],
    },
    {
      id: 'catgate-org/catgate-fixture-model-b',
      object: 'model',
      created: 1_755_800_001,
      owned_by: 'catgate-org',
      providers: [{ provider: 'groq', status: 'live', context_length: 65_536, supports_tools: false }],
    },
  ],
})

const server = createServer((req, res) => {
  const line = `${new Date().toISOString()} ${req.method} ${req.url}`
  if (ledger) {
    try {
      appendFileSync(ledger, line + '\n')
    } catch {
      /* the ledger is best-effort; the prover also counts via the tripwire log */
    }
  }
  const answer = (): void => {
    if ((req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(BODY)
    } else {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    }
  }
  if (delayMs > 0) setTimeout(answer, delayMs)
  else answer()
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
