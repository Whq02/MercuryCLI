#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const mode = process.env.FAKE_LSP_MODE ?? 'normal'
const initDelayMs = Number(process.env.FAKE_LSP_INIT_DELAY_MS ?? '1200')
if (process.env.FAKE_LSP_PID_FILE) {
  try {
    appendFileSync(process.env.FAKE_LSP_PID_FILE, `${process.pid}\n`)
  } catch {
  }
}
let cancelsSeen = 0

let buf = Buffer.alloc(0)
let nextServerRequestId = 1000
const pendingConfigTags = new Map()

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function onMessage(msg) {
  if (msg.method === 'test/ping') {
    const tag = msg.params?.tag ?? 'untagged'
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///probe.ts',
        diagnostics: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: `probe ${tag}` },
        ],
      },
    })
    send({ jsonrpc: '2.0', method: 'test/extra', params: { tag } })
    const id = nextServerRequestId++
    pendingConfigTags.set(id, tag)
    send({ jsonrpc: '2.0', id, method: 'workspace/configuration', params: { items: [{ section: 'python' }] } })
    return
  }
  if (msg.method === undefined && msg.id !== undefined && pendingConfigTags.has(msg.id)) {
    const tag = pendingConfigTags.get(msg.id)
    pendingConfigTags.delete(msg.id)
    send({
      jsonrpc: '2.0',
      method: 'test/configAnswer',
      params: { tag, result: msg.result ?? null, error: msg.error ?? null },
    })
    return
  }
  if (msg.method === 'initialize') {
    if (mode === 'slow-init') {
      setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }), initDelayMs)
      return
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } })
    return
  }
  if (msg.method === 'initialized') {
    if (mode === 'crash-after-init') setTimeout(() => process.exit(1), 500)
    return
  }
  if (msg.method === 'shutdown') {
    if (mode === 'ignore-shutdown') return
    send({ jsonrpc: '2.0', id: msg.id, result: null })
    return
  }
  if (msg.method === 'exit') {
    if (mode === 'ignore-shutdown') return
    process.exit(0)
  }
  if (msg.method === '$/cancelRequest') {
    cancelsSeen++
    return
  }
  if (msg.method === 'fake/cancelCount') {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: { cancels: cancelsSeen } })
    return
  }
  if (mode === 'wedged') return
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: null })
}

process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buf.slice(0, headerEnd).toString('utf8')
    const m = /Content-Length: (\d+)/i.exec(header)
    if (!m) {
      buf = buf.slice(headerEnd + 4)
      continue
    }
    const len = Number(m[1])
    const start = headerEnd + 4
    if (buf.length < start + len) return
    const body = buf.slice(start, start + len).toString('utf8')
    buf = buf.slice(start + len)
    try {
      onMessage(JSON.parse(body))
    } catch {
    }
  }
})

if (mode === 'ignore-shutdown') setInterval(() => {}, 1000)
