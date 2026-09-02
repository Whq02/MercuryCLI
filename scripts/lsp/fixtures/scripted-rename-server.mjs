#!/usr/bin/env node
// scripted-rename-server — a stdio LSP server for the pathRename fan-out
// proof. Env-scripted:
//   RENAME_CAPS   — JSON merged into the initialize capabilities (e.g.
//                   {"workspace":{"fileOperations":{"willRename":{},"didRename":{}}}})
//   RENAME_EDITS  — JSON WorkspaceEdit returned for workspace/willRenameFiles
//   RENAME_LOG    — a file path; every received method is appended one/line
import { appendFileSync } from 'node:fs'

const caps = process.env.RENAME_CAPS ? JSON.parse(process.env.RENAME_CAPS) : {}
const edits = process.env.RENAME_EDITS ? JSON.parse(process.env.RENAME_EDITS) : null
const logPath = process.env.RENAME_LOG

let buf = Buffer.alloc(0)

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function log(line) {
  if (logPath) {
    try {
      appendFileSync(logPath, line + '\n')
    } catch {
      /* the proof reads what it can */
    }
  }
}

function onMessage(msg) {
  if (msg.method) log(msg.method)
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: caps } })
    return
  }
  if (msg.method === 'workspace/willRenameFiles') {
    send({ jsonrpc: '2.0', id: msg.id, result: edits })
    return
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null })
    return
  }
  if (msg.method === 'exit') process.exit(0)
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
      // malformed frames are the driver's problem, not ours
    }
  }
})
