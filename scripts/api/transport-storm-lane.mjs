#!/usr/bin/env node
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import * as undici from 'undici'

const bundlePath = process.argv[2]
if (!bundlePath) {
  console.error('usage: node transport-storm-lane.mjs <proxy-bundle.mjs>')
  process.exit(2)
}
if (typeof Bun !== 'undefined') {
  console.error('this battery must run under node, not bun')
  process.exit(2)
}

let failures = 0
const check = (label, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = title => console.log(`\n── ${title} ──`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

for (const name of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY']) delete process.env[name]
delete process.env.MERCURY_MAX_CONNECTIONS

const mod = await import(pathToFileURL(bundlePath).href)
const { getProxyFetchOptions, getApiDispatcher, _resetApiDispatcherForTesting, resolveTransportKnobs, isStaleSocketCode, deepestErrorDetail } = mod

const STALL_MS = 1500
const BIG_BODY_BYTES = 8 * 1024 * 1024

let connectionCount = 0
const connectionIds = new WeakMap()
const idOf = socket => {
  if (!connectionIds.has(socket)) connectionIds.set(socket, ++connectionCount)
  return connectionIds.get(socket)
}
const seen = []
const live = new Map()
const sse = i => `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"w${i}"}}\n\n`

const server = http.createServer((req, res) => {
  const id = req.headers['x-lane-id'] ?? ''
  const path = (req.url ?? '').split('?')[0]
  const socket = req.socket
  const record = { path, id, connection: idOf(socket), bodyBytes: 0, stalled: false, resetAtMs: null }
  seen.push(record)
  if (path === '/stall') {
    record.stalled = true
    let read = 0
    const started = Date.now()
    req.once('data', chunk => {
      read += chunk.length
      record.bodyBytes = read
      req.pause()
      setTimeout(() => {
        record.resetAtMs = Date.now() - started
        socket.resetAndDestroy()
      }, STALL_MS)
    })
    return
  }
  req.on('data', chunk => { record.bodyBytes += chunk.length })
  req.on('end', () => {
    if (path === '/hold') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse(0))
      live.set(id, res)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(0) + sse(1))
  })
})
server.keepAliveTimeout = 60_000
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

async function streamOnce(id, path, body = JSON.stringify({ model: 'fixture', stream: true, messages: [{ role: 'user', content: 'hi' }] })) {
  const result = { id, bytes: 0, error: null, phase: 'request', startedAt: Date.now(), failedAfterMs: null }
  try {
    const response = await undici.fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lane-id': id },
      body,
      ...getProxyFetchOptions({ forAnthropicAPI: true }),
    })
    result.phase = 'body'
    for await (const chunk of response.body) result.bytes += chunk.byteLength
    result.phase = 'done'
  } catch (err) {
    result.error = err
    result.failedAfterMs = Date.now() - result.startedAt
  }
  return result
}
const codeOf = result => (result.error ? deepestErrorDetail(result.error).code ?? result.error?.cause?.code ?? result.error?.code ?? result.error?.name : null)
const waitFor = async (predicate, ms) => {
  const until = Date.now() + ms
  while (Date.now() < until && !predicate()) await sleep(10)
  return predicate()
}

section('§1 sixteen replies streaming, a seventeenth request arrives: it reaches the edge at once on its own connection')
{
  _resetApiDispatcherForTesting()
  const knobs = resolveTransportKnobs()
  check('the dispatcher carries no connection bound unless the operator pins one', knobs.maxConnections === null, String(knobs.maxConnections))
  seen.length = 0
  live.clear()
  const held = Array.from({ length: 16 }, (_, i) => `h-${i}`)
  const runs = held.map(id => streamOnce(id, '/hold'))
  const allLive = await waitFor(() => held.every(id => live.has(id)), 4000)
  check('sixteen streams are live at the edge', allLive, `${live.size} live`)
  const seventeenth = streamOnce('s-17', '/answer')
  const arrived = await waitFor(() => seen.some(r => r.id === 's-17'), 1500)
  const row = seen.find(r => r.id === 's-17')
  check('the seventeenth request reaches the edge within 1.5 s while the sixteen streams still run (the base queues it until a stream ends)', arrived, arrived ? `on connection #${row.connection}` : 'never arrived')
  const connections = new Set(seen.filter(r => r.path === '/hold').map(r => r.connection))
  check('…on a seventeenth connection, not one the streams hold', arrived && !connections.has(row.connection) && connections.size === 16, `${connections.size} stream connections, request on #${row?.connection}`)
  const answered = await Promise.race([seventeenth, sleep(3000).then(() => null)])
  check('the seventeenth request is answered before any stream ends', answered !== null && answered.phase === 'done' && answered.error === null && live.size === 16, answered === null ? 'still queued after 3 s' : `${answered.phase} ${codeOf(answered) ?? ''}`)
  for (const out of live.values()) out.end(sse(1))
  await seventeenth
  const results = await Promise.all(runs)
  check('every held stream completes when the edge ends it', results.every(r => r.phase === 'done' && r.error === null), results.map(r => `${r.id}:${r.phase}`).join(' '))
}

section('§2 the operator’s bound still bounds: MERCURY_MAX_CONNECTIONS=4 queues the fifth request behind the four streams')
{
  process.env.MERCURY_MAX_CONNECTIONS = '4'
  _resetApiDispatcherForTesting()
  check('the knob is honoured', resolveTransportKnobs().maxConnections === 4, String(resolveTransportKnobs().maxConnections))
  seen.length = 0
  live.clear()
  const held = Array.from({ length: 4 }, (_, i) => `b-${i}`)
  const runs = held.map(id => streamOnce(id, '/hold'))
  await waitFor(() => held.every(id => live.has(id)), 4000)
  const fifth = streamOnce('b-5', '/answer')
  const arrivedEarly = await waitFor(() => seen.some(r => r.id === 'b-5'), 600)
  check('the fifth request waits in the queue while the four streams run', !arrivedEarly)
  for (const out of live.values()) out.end(sse(1))
  await Promise.all(runs)
  const answered = await fifth
  check('…and is served once a stream ends', answered.phase === 'done' && seen.some(r => r.id === 'b-5'), answered.phase)
  delete process.env.MERCURY_MAX_CONNECTIONS
  _resetApiDispatcherForTesting()
}

section(`§3 the field’s storm: an edge that stops reading one upload and resets it after ${STALL_MS} ms of stall, under ten concurrent requests`)
{
  seen.length = 0
  live.clear()
  const big = JSON.stringify({ model: 'fixture', stream: true, messages: [{ role: 'user', content: 'x'.repeat(BIG_BODY_BYTES) }] })
  const ids = Array.from({ length: 10 }, (_, i) => `f-${i}`)
  const runs = ids.map((id, i) => streamOnce(id, i === 0 ? '/stall' : '/hold', big))
  await waitFor(() => ids.slice(1).every(id => live.has(id)), 6000)
  const cutResult = await runs[0]
  const stalledRow = seen.find(r => r.stalled)
  check('the edge read the first bytes of the stalled upload, then nothing more, then reset the connection at its timer', stalledRow !== undefined && stalledRow.bodyBytes > 0 && stalledRow.bodyBytes < BIG_BODY_BYTES && stalledRow.resetAtMs !== null && stalledRow.resetAtMs >= STALL_MS, JSON.stringify({ bodyBytes: stalledRow?.bodyBytes, resetAtMs: stalledRow?.resetAtMs }))
  const code = codeOf(cutResult)
  check(`the stalled request fails at the edge’s timer with a kernel reset code the ladder reads as a stale socket (${String(code)})`, cutResult.error !== null && cutResult.failedAfterMs >= STALL_MS && cutResult.failedAfterMs < STALL_MS * 4 && isStaleSocketCode(code), `${cutResult.phase} after ${cutResult.failedAfterMs} ms: ${cutResult.error?.name}: ${cutResult.error?.message} ← ${String(code)}`)
  const liveNine = ids.slice(1).every(id => live.has(id))
  check('the nine sibling uploads of the same size are untouched: each on its own connection, all live at the edge', liveNine && new Set(seen.filter(r => r.path === '/hold').map(r => r.connection)).size === 9, `${live.size} live`)
  for (const out of live.values()) out.end(sse(1))
  const results = await Promise.all(runs.slice(1))
  check('the nine complete when the edge ends them', results.every(r => r.phase === 'done' && r.error === null), results.map(r => `${r.id}:${r.phase}${r.error ? `(${codeOf(r)})` : ''}`).join(' '))
  const retry = await streamOnce('f-retry', '/answer', big)
  const retryRow = seen.find(r => r.id === 'f-retry')
  check('a retry of the cut request rides a fresh connection and is answered', retry.phase === 'done' && retryRow !== undefined && retryRow.connection !== stalledRow?.connection, `${retry.phase} on #${retryRow?.connection} (cut was #${stalledRow?.connection})`)
}

await new Promise(resolve => server.close(resolve))
try { await getApiDispatcher().close?.() } catch { }

console.log('')
if (failures > 0) {
  console.log(`❌ TRANSPORT STORM LANE RED — ${failures} failing check(s)`)
  process.exit(1)
}
console.log('✅ TRANSPORT STORM LANE GREEN')
process.exit(0)
