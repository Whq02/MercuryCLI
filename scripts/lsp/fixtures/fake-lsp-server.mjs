#!/usr/bin/env node
// fake-lsp-server — a scripted stdio LSP server for the lifecycle-config
// proof (prove-lsp-lifecycle-config.ts). Speaks Content-Length framed
// JSON-RPC; behavior is selected by FAKE_LSP_MODE:
//   normal           — initialize → capabilities; shutdown → null; exit → 0
//   crash-after-init — answers initialize, then exits(1) ~80ms later (a crash)
//   ignore-shutdown  — answers initialize, then never answers shutdown and
//                      ignores the exit notification (stays alive until
//                      force-killed) — exercises the graceful-shutdown deadline
//   wedged           — answers initialize (and shutdown/exit), then NEVER
//                      answers any other request: the wedged-server shape
//                      (clangd or pyright mid-reindex, a sidecar loading a
//                      large program off a spinning disk). Every
//                      `$/cancelRequest` it receives is COUNTED and the
//                      count is answered by the `fake/cancelCount` request,
//                      so a proof can show the cancel reached the wire.
//   In every mode, a `test/ping` notification (params.tag) makes the server
//   push one textDocument/publishDiagnostics notification and send one
//   workspace/configuration request to the client, then relay the client's
//   answer (result or error) as a `test/configAnswer` notification carrying
//   the same tag — the handler-replay proof (prove-lsp-handler-replay.ts)
//   reads both across a stop/start of the same client. (The ping arms sit
//   ahead of the wedged return; the wedged proof never sends one.)
//   slow-init        — answers initialize only after FAKE_LSP_INIT_DELAY_MS
//                      (default 1200): the cold-start window a spinning disk
//                      makes long. shutdown/exit are answered meanwhile.
//   In every mode, FAKE_LSP_PID_FILE=<path> appends this process's pid on
//   start — the liveness witness for the shutdown proofs.
import { appendFileSync } from 'node:fs'
const mode = process.env.FAKE_LSP_MODE ?? 'normal'
const initDelayMs = Number(process.env.FAKE_LSP_INIT_DELAY_MS ?? '1200')
if (process.env.FAKE_LSP_PID_FILE) {
  try {
    appendFileSync(process.env.FAKE_LSP_PID_FILE, `${process.pid}\n`)
  } catch {
    // the witness never fails the server
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
    // A custom notification too, for a handler the proof registers WHILE
    // connected.
    send({ jsonrpc: '2.0', method: 'test/extra', params: { tag } })
    const id = nextServerRequestId++
    pendingConfigTags.set(id, tag)
    send({ jsonrpc: '2.0', id, method: 'workspace/configuration', params: { items: [{ section: 'python' }] } })
    return
  }
  // A RESPONSE to one of our own requests (no method, a known id).
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
    if (mode === 'crash-after-init') {
      setTimeout(() => process.exit(1), 80)
    }
    return
  }
  if (msg.method === 'shutdown') {
    if (mode === 'ignore-shutdown') return // never answer — the deadline case
    send({ jsonrpc: '2.0', id: msg.id, result: null })
    return
  }
  if (msg.method === 'exit') {
    if (mode === 'ignore-shutdown') return // ignore — stay alive until killed
    process.exit(0)
  }
  if (msg.method === '$/cancelRequest') {
    cancelsSeen++
    return // a notification: never answered, only counted
  }
  if (msg.method === 'fake/cancelCount') {
    // The proof's own read-back door — answered even in `wedged`.
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: { cancels: cancelsSeen } })
    return
  }
  if (mode === 'wedged') return // never answers — the hung-request case
  // Any other REQUEST gets an empty result so nothing hangs on us.
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
      // ignore malformed frames — the proof drives well-formed traffic
    }
  }
})

// ignore-shutdown must survive stdin closing (the client disposes the
// connection before killing) — keep an interval alive so node doesn't exit.
if (mode === 'ignore-shutdown') setInterval(() => {}, 1000)
