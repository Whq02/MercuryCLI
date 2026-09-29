#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import { join } from 'node:path'

const argAfter = flag => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const dir = argAfter('--dir')
const plan = (argAfter('--plan') ?? 'full').split(',')
const tls = process.argv.includes('--tls')
if (!dir) {
  console.error('usage: streamCutFixture.mjs --dir <dir> --plan rst,full [--tls]')
  process.exit(2)
}
const seenFile = join(dir, 'seen.jsonl')
const sse = o => `data: ${JSON.stringify(o)}\n\n`
const streamedHead = () =>
  `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}` +
  `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`
const streamedDelta = text => `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`
const streamedTail = () =>
  `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}` +
  `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } })}` +
  `event: message_stop\n${sse({ type: 'message_stop' })}`
const collectedJson = JSON.stringify({ id: 'msg_ns', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'recovered without streaming' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 6, output_tokens: 2 } })

let connections = 0
const connectionIds = new WeakMap()
const idOf = socket => {
  if (!connectionIds.has(socket)) connectionIds.set(socket, ++connections)
  return connectionIds.get(socket)
}

function answer(out, request) {
  const path = request.path.split('?')[0]
  if (!(request.method === 'POST' && path.endsWith('/v1/messages'))) {
    out.head(200, 'application/json')
    out.end('{}')
    return
  }
  let body = {}
  try {
    body = JSON.parse(request.body)
  } catch {}
  const stream = body.stream === true
  const step = plan.shift() ?? 'full'
  appendFileSync(seenFile, `${JSON.stringify({ stream, step, protocol: request.protocol, connection: request.connection })}\n`)
  if (!stream) {
    out.head(200, 'application/json')
    if (step === 'rst') {
      out.write(collectedJson.slice(0, 40))
      setTimeout(() => out.cut(), 100)
      return
    }
    out.end(collectedJson)
    return
  }
  out.head(200, 'text/event-stream')
  out.write(streamedHead())
  out.write(streamedDelta(step === 'rst' ? 'the partial words before the cut' : 'the whole reply'))
  if (step === 'rst') {
    setTimeout(() => out.cut(), 100)
    return
  }
  out.end(streamedTail())
}

function onH1Request(req, res) {
  if (req.httpVersion === '2.0') return
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    answer(
      {
        head: (status, type) => res.writeHead(status, { 'content-type': type }),
        write: text => res.write(text),
        end: text => res.end(text),
        cut: () => res.destroy(),
      },
      { method: req.method, path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8'), protocol: req.socket.alpnProtocol ?? 'http/1.1', connection: idOf(req.socket) },
    )
  })
}

function onH2Stream(stream, headers) {
  stream.on('error', () => {})
  const chunks = []
  stream.on('data', c => chunks.push(c))
  stream.on('end', () => {
    answer(
      {
        head: (status, type) => stream.respond({ ':status': status, 'content-type': type }),
        write: text => stream.write(text),
        end: text => stream.end(text),
        cut: () => stream.destroy(new Error('reset mid body')),
      },
      { method: headers[':method'], path: headers[':path'] ?? '', body: Buffer.concat(chunks).toString('utf8'), protocol: 'h2', connection: idOf(stream.session.socket) },
    )
  })
}

let server
if (tls) {
  server = http2.createSecureServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')), allowHTTP1: true })
  server.on('stream', onH2Stream)
  server.on('request', onH1Request)
} else {
  server = http.createServer(onH1Request)
}
server.listen(0, '127.0.0.1', () => {
  console.log(`PORT ${server.address().port}`)
})
process.on('SIGTERM', () => {
  server.close()
  process.exit(0)
})
