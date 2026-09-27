#!/usr/bin/env node
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const bundlePath = process.argv[2]
if (!bundlePath) {
  console.error('usage: node native-road-node-lane.mjs <native-road-bundle.mjs>')
  process.exit(2)
}
if (typeof Bun !== 'undefined') {
  console.error('this lane must run under node, not bun')
  process.exit(2)
}
globalThis.MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const MODEL = 'qwen3.5:9b-q4_K_M'
const HOLD_MS = 2_500
const row = data => `${JSON.stringify(data)}\n`
const rows = [
  row({ model: MODEL, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '', thinking: 'Let me think.' }, done: false }),
  row({ model: MODEL, created_at: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: 'Ping!' }, done: false }),
  row({ model: MODEL, created_at: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 62_908, prompt_eval_duration: 250_000_000_000, eval_count: 5, eval_duration: 200_000_000 }),
]
const seen = []
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/version') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"version":"0.34.4"}')
    return
  }
  if (req.method === 'GET' && req.url === '/api/ps') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, size: 6_000_000_000 }] }))
    return
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      seen.push({ url: req.url, body })
      setTimeout(() => {
        if (res.destroyed) return
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        for (const line of rows) res.write(line)
        res.end()
      }, HOLD_MS)
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const root = `http://127.0.0.1:${port}`

const mod = await import(pathToFileURL(bundlePath).href)
const { streamOllamaChat } = mod
const law = {
  wireModel: MODEL,
  serverWords: `Ollama at 127.0.0.1:${port}`,
  cold: true,
  promiseMs: 60_000,
  paceTokensPerSec: 300,
  uncachedTokens: 65_000,
  loadedAtSend: true,
  capMs: 7_200_000,
  seam: { probe: async () => true, loaded: async () => true, sizeGb: async () => undefined },
  noteTurn() {},
}
const events = []
let text = ''
const startedAt = Date.now()
for await (const event of streamOllamaChat(
  {
    url: `${root}/api/chat`,
    request: { model: MODEL, messages: [{ role: 'user', content: 'Hey say ping' }] },
    idleTimeoutMs: 900_000,
    firstByte: { cold: true, promptTokens: 65_000, model: MODEL },
    local: law,
  },
  { numCtx: 131_072, think: true },
)) {
  events.push(event)
  if (event.type === 'text-delta') text += event.text
}
const elapsedMs = Date.now() - startedAt
const faults = events.filter(e => e.type === 'stream-fault').map(e => e.fault)
console.log(`  node ${process.version} · headers held ${HOLD_MS} ms · MERCURY_API_TIMEOUT_MS=${process.env.MERCURY_API_TIMEOUT_MS} · ${elapsedMs} ms · events ${events.map(e => e.type).join(',')}`)
check('no fault: the API dispatcher\'s 1 s headers budget did not cut a 2.5 s headers wait — the native road hands its fetch its own dispatcher', faults.length === 0, JSON.stringify(faults))
check('the reply landed after the wait: thinking, text, finish', text === 'Ping!' && events.some(e => e.type === 'reasoning-delta') && events.some(e => e.type === 'finish'), JSON.stringify({ text, types: events.map(e => e.type) }))
check('exactly one POST reached the server (nothing reissued, nothing re-ingested)', seen.length === 1, String(seen.length))
check('the wait was long enough to have tripped the 1 s budget', elapsedMs >= HOLD_MS - 50, String(elapsedMs))
server.close()
process.exit(failures === 0 ? 0 : 1)
