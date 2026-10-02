#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'compat-wire-dump-home-'))
const DUMP = join(HOME, 'wire')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_WIRE_DUMP = DUMP
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.HTTPS_PROXY
delete process.env.HTTP_PROXY
delete process.env.https_proxy
delete process.env.http_proxy

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const seen: Array<{ method: string; url: string; body: string }> = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = ''
  req.on('data', chunk => {
    body += String(chunk)
  })
  req.on('end', () => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', body })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse({ choices: [{ delta: { content: 'Hello' } }] }))
    res.write(sse({ choices: [{ delta: { content: ' world' } }] }))
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }))
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port
const url = `http://127.0.0.1:${port}/v1/chat/completions`

console.log('the compatible chat lane rides the wire dump like the Anthropic and OpenAI lanes')
try {
  const events: Array<{ type: string }> = []
  for await (const event of streamCompatChat({
    apiKey: 'sk-proof-secret-not-a-real-key',
    url,
    request: { model: 'fixture-chat', messages: [{ role: 'user', content: 'hi' }] },
  })) {
    events.push(event as { type: string })
  }
  check('the turn reached the loopback server once, as a POST to the chat-completions path', seen.length === 1 && seen[0]!.method === 'POST' && seen[0]!.url === '/v1/chat/completions', JSON.stringify(seen))
  check('the turn finished', events.some(event => event.type === 'finish'), JSON.stringify(events.map(event => event.type)))
  await new Promise(resolve => setTimeout(resolve, 200))
  const files = existsSync(DUMP) ? readdirSync(DUMP).filter(name => name.endsWith('.jsonl')) : []
  check('one dump file was written for the session', files.length === 1, JSON.stringify(files))
  const rows = files.flatMap(name => readFileSync(join(DUMP, name), 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>))
  const request = rows.find(row => row.kind === 'request')
  check('the dump holds the request row for the chat-completions call', request !== undefined && request.url === '/v1/chat/completions' && request.model === 'fixture-chat' && request.source === 'compat', JSON.stringify(rows).slice(0, 400))
  const response = (request?.response ?? {}) as Record<string, unknown>
  check('the row carries the response facts (status 200, the finish reason, the usage)', response.status === 200 && JSON.stringify(response).includes('stop') && JSON.stringify(response).includes('11'), JSON.stringify(response))
  check('no credential reaches the file', !JSON.stringify(rows).includes('sk-proof-secret'))
} finally {
  server.close()
  rmSync(HOME, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nprove-compat-wire-dump: ${failures} FAILED`)
  process.exit(1)
}
console.log('\nprove-compat-wire-dump: all green')
