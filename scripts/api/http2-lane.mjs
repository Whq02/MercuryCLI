#!/usr/bin/env node
import http from 'node:http'
import http2 from 'node:http2'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as undici from 'undici'

const bundlePath = process.argv[2]
const tlsDir = process.argv[3]
if (!bundlePath || !tlsDir) {
  console.error('usage: node http2-lane.mjs <proxy-bundle.mjs> <dir with key.pem and cert.pem>')
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
delete process.env.MERCURY_CLIENT_CERT
delete process.env.MERCURY_CLIENT_KEY
delete process.env.MERCURY_PROXY_RESOLVES_HOSTS
process.env.NODE_EXTRA_CA_CERTS = join(tlsDir, 'cert.pem')

const mod = await import(pathToFileURL(bundlePath).href)
const {
  getProxyFetchOptions,
  getApiDispatcher,
  getProxyAgent,
  buildApiAgentOptions,
  buildProxyAgentOptions,
  clearProxyCache,
  _resetApiDispatcherForTesting,
  isStaleSocketCode,
  transportCutOf,
  deepestErrorDetail,
} = mod

const { NGHTTP2_REFUSED_STREAM, NGHTTP2_NO_ERROR } = http2.constants
let connectionCount = 0
const connectionIds = new WeakMap()
const idOf = socket => {
  if (!connectionIds.has(socket)) connectionIds.set(socket, ++connectionCount)
  return connectionIds.get(socket)
}
const seen = []
const live = new Map()
let refuseAfter = Infinity
let h2StreamsOnSession = new WeakMap()

const sse = i => `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"w${i}"}}\n\n`

function serve(out, request) {
  const path = request.path.split('?')[0]
  const id = request.id
  seen.push({ path, protocol: request.protocol, connection: request.connection, id })
  if (path === '/sse') {
    out.head(200, 'text/event-stream')
    out.write(sse(0))
    live.set(id, out)
    return
  }
  out.head(200, 'application/json')
  out.end('{}')
}

const server = http2.createSecureServer({
  key: readFileSync(join(tlsDir, 'key.pem')),
  cert: readFileSync(join(tlsDir, 'cert.pem')),
  allowHTTP1: true,
})
server.on('request', (req, res) => {
  if (req.httpVersion === '2.0') return
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const socket = req.socket
    const id = req.headers['x-lane-id'] ?? ''
    serve(
      {
        head: (status, type) => res.writeHead(status, { 'content-type': type }),
        write: text => res.write(text),
        end: text => res.end(text),
        cut: () => socket.destroy(),
        socketId: idOf(socket),
      },
      { path: req.url ?? '', protocol: socket.alpnProtocol ?? 'http/1.1', connection: idOf(socket), id },
    )
  })
})
server.on('stream', (stream, headers) => {
  stream.on('error', () => {})
  const session = stream.session
  const count = (h2StreamsOnSession.get(session) ?? 0) + 1
  h2StreamsOnSession.set(session, count)
  if (count > refuseAfter) {
    seen.push({ path: headers[':path'] ?? '', protocol: 'h2', connection: idOf(session.socket), id: headers['x-lane-id'] ?? '', refused: true })
    stream.close(NGHTTP2_REFUSED_STREAM)
    return
  }
  const chunks = []
  stream.on('data', c => chunks.push(c))
  stream.on('end', () => {
    serve(
      {
        head: (status, type) => stream.respond({ ':status': status, 'content-type': type }),
        write: text => stream.write(text),
        end: text => stream.end(text),
        cut: () => session.socket.destroy(),
        goaway: lastId => session.goaway(NGHTTP2_NO_ERROR, lastId),
        streamId: stream.id,
        socketId: idOf(session.socket),
      },
      { path: headers[':path'] ?? '', protocol: 'h2', connection: idOf(session.socket), id: headers['x-lane-id'] ?? '' },
    )
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `https://127.0.0.1:${server.address().port}`

async function streamOnce(id, fetchOptions, path = '/sse') {
  const result = { id, bytes: 0, error: null, phase: 'request' }
  try {
    const response = await undici.fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lane-id': id },
      body: JSON.stringify({ model: 'fixture', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      ...fetchOptions,
    })
    result.phase = 'body'
    for await (const chunk of response.body) result.bytes += chunk.byteLength
    result.phase = 'done'
  } catch (err) {
    result.error = err
  }
  return result
}
const codeOf = result => (result.error ? deepestErrorDetail(result.error).code ?? result.error?.cause?.code ?? result.error?.code ?? result.error?.name : null)
const waitLive = async (ids, ms = 4000) => {
  const until = Date.now() + ms
  while (Date.now() < until && !ids.every(id => live.has(id))) await sleep(10)
  return ids.every(id => live.has(id))
}

const roads = [
  { name: 'Anthropic road (the main chat and every crewmate)', options: () => getProxyFetchOptions({ forAnthropicAPI: true }) },
  { name: 'bare-option roads (Gemini, OpenAI, compat)', options: () => getProxyFetchOptions() },
]

const protocolExpected = 'http/1.1'
const N = 6

for (const road of roads) {
  _resetApiDispatcherForTesting()
  section(`§1 ${road.name}: ${N} concurrent streaming POSTs — protocol and connections`)
  {
    seen.length = 0
    live.clear()
    const ids = Array.from({ length: N }, (_, i) => `p-${i}`)
    const runs = ids.map(id => streamOnce(id, road.options()))
    const allLive = await waitLive(ids)
    const rows = seen.filter(s => s.path === '/sse')
    const protocols = new Set(rows.map(r => r.protocol))
    const connections = new Set(rows.map(r => r.connection))
    check(`all ${N} streams are live at the edge`, allLive, `${live.size} live`)
    check(`the negotiated protocol is ${protocolExpected} on every stream`, rows.length === N && protocols.size === 1 && protocols.has(protocolExpected), [...protocols].join(','))
    check(`${N} concurrent streams occupy ${N} connections (one request per connection, never one shared session)`, connections.size === N, `${connections.size} connection(s): ${rows.map(r => `${r.id}#${r.connection}`).join(' ')}`)
    for (const out of live.values()) out.end(sse(1))
    const results = await Promise.all(runs)
    check('every stream completes when the edge ends it', results.every(r => r.phase === 'done' && r.error === null), results.map(r => `${r.id}:${r.phase}${r.error ? `(${codeOf(r)})` : ''}`).join(' '))
  }

  section(`§2 ${road.name}: one connection closed by the edge under ${N} live streams`)
  {
    seen.length = 0
    live.clear()
    const ids = Array.from({ length: N }, (_, i) => `c-${i}`)
    const runs = ids.map(id => streamOnce(id, road.options()))
    await waitLive(ids)
    const victim = live.get(ids[0])
    victim.cut()
    await sleep(300)
    for (const [id, out] of live) if (id !== ids[0]) { try { out.end(sse(1)) } catch {} }
    const results = await Promise.all(runs)
    const cut = results.filter(r => r.error !== null)
    const survivors = results.filter(r => r.error === null && r.phase === 'done')
    const rows = seen.filter(s => s.path === '/sse')
    check(`exactly one stream is cut (the one on the closed connection), ${N - 1} finish untouched`, cut.length === 1 && survivors.length === N - 1, `${cut.length} cut, ${survivors.length} finished: ${results.map(r => `${r.id}:${r.phase}${r.error ? `(${codeOf(r)})` : ''}`).join(' ')} · at the edge ${rows.map(r => `${r.id}@${r.protocol}#${r.connection}`).join(' ')}`)
    const code = cut[0] ? codeOf(cut[0]) : null
    check('the cut carries a stale-socket code the ladder reads', code !== null && isStaleSocketCode(code), String(code))
    check('…and the stream core reads it as a mid-response transport cut', cut[0] !== undefined && transportCutOf(cut[0].error) !== null, cut[0] ? `${cut[0].error?.name}: ${cut[0].error?.message} ← ${code}` : 'no cut')
    check('no cut carries an HTTP/2 code', !cut.some(r => String(codeOf(r)).startsWith('ERR_HTTP2')), cut.map(codeOf).join(','))
  }

  section(`§3 ${road.name}: an edge that refuses every stream past the first on a session`)
  {
    seen.length = 0
    live.clear()
    refuseAfter = 1
    const ids = Array.from({ length: 3 }, (_, i) => `r-${i}`)
    const runs = ids.map(id => streamOnce(id, road.options()))
    await waitLive(ids, 1500)
    for (const out of live.values()) { try { out.end(sse(1)) } catch {} }
    const results = await Promise.all(runs)
    refuseAfter = Infinity
    const refused = seen.filter(s => s.refused === true)
    const failed = results.filter(r => r.error !== null)
    check('no stream can be refused: each request has its own connection, so there is no second stream on a session', refused.length === 0 && failed.length === 0, `${refused.length} refused at the edge, ${failed.length} failed: ${failed.map(r => `${r.id}:${codeOf(r)}`).join(' ')}`)
    check('no request fails with ERR_HTTP2_STREAM_ERROR (the code the chat shows as "Connection error. [ERR_HTTP2_STREAM_ERROR]")', !failed.some(r => codeOf(r) === 'ERR_HTTP2_STREAM_ERROR'), failed.map(r => `${r.id}:${codeOf(r)} ${r.error?.cause?.message ?? ''}`).join(' | '))
  }
}

section('§4 the dispatcher options say HTTP/1.1 on both the direct and the proxy paths')
{
  const direct = buildApiAgentOptions()
  check('buildApiAgentOptions(): allowH2 is false', direct.allowH2 === false, JSON.stringify({ allowH2: direct.allowH2 }))
  const viaProxy = buildProxyAgentOptions('http://127.0.0.1:1')
  check('buildProxyAgentOptions(): allowH2 is false', viaProxy.allowH2 === false, JSON.stringify({ allowH2: viaProxy.allowH2 }))
}

section('§5 through a CONNECT proxy the tunnel keeps HTTP/1.1 too')
{
  const proxy = http.createServer((req, res) => { res.writeHead(400); res.end() })
  proxy.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':')
    const socket = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) socket.write(head)
      socket.pipe(clientSocket)
      clientSocket.pipe(socket)
    })
    socket.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => socket.destroy())
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  process.env.HTTPS_PROXY = proxyUrl
  clearProxyCache()
  const options = getProxyFetchOptions({ forAnthropicAPI: true })
  check('the proxy dispatcher is in play', options.dispatcher === getProxyAgent(proxyUrl) && options.dispatcher?.constructor?.name === 'EnvHttpProxyAgent', String(options.dispatcher?.constructor?.name))
  seen.length = 0
  live.clear()
  const ids = ['x-0', 'x-1', 'x-2']
  const runs = ids.map(id => streamOnce(id, options))
  await waitLive(ids)
  const rows = seen.filter(s => s.path === '/sse')
  const protocols = new Set(rows.map(r => r.protocol))
  const connections = new Set(rows.map(r => r.connection))
  check(`tunnelled streams negotiate ${protocolExpected} with the edge`, rows.length === ids.length && protocols.size === 1 && protocols.has(protocolExpected), [...protocols].join(','))
  check('tunnelled streams take one connection each', connections.size === ids.length, `${connections.size} connection(s)`)
  for (const out of live.values()) { try { out.end(sse(1)) } catch {} }
  const results = await Promise.all(runs)
  check('every tunnelled stream completes', results.every(r => r.phase === 'done'), results.map(r => `${r.id}:${r.phase}${r.error ? `(${codeOf(r)})` : ''}`).join(' '))
  delete process.env.HTTPS_PROXY
  clearProxyCache()
  await new Promise(resolve => proxy.close(resolve))
}

await new Promise(resolve => server.close(resolve))
try { await getApiDispatcher().close?.() } catch { }

console.log('')
if (failures > 0) {
  console.log(`❌ HTTP2 LANE RED — ${failures} failing check(s)`)
  process.exit(1)
}
console.log('✅ HTTP2 LANE GREEN')
process.exit(0)
