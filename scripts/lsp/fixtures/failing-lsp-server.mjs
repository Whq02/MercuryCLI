#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const mode = process.env.FAILING_LSP_MODE ?? 'refuse-initialize'
const counterFile = process.env.FAILING_LSP_COUNTER
const failTimes = Number(process.env.FAILING_LSP_FAIL_TIMES ?? '2')
const spawnOrdinal = (() => {
  if (!counterFile) return 1
  const prior = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8').trim() || '0') : 0
  writeFileSync(counterFile, String(prior + 1))
  return prior + 1
})()
if (process.env.FAILING_LSP_PID_FILE) appendFileSync(process.env.FAILING_LSP_PID_FILE, `${process.pid}\n`)

if (mode === 'exit-before-initialize') {
  process.stderr.write('fixture-ts: the typescript compiler is missing from this machine\n')
  process.exit(1)
}

const send = row => {
  const text = JSON.stringify({ jsonrpc: '2.0', ...row })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`)
}
const refuseInitialize = mode === 'refuse-initialize' || (mode === 'fail-then-ok' && spawnOrdinal <= failTimes)
const diagnostic = { range: { start: { line: 1, character: 13 }, end: { line: 1, character: 18 } }, severity: 1, code: 2322, source: 'fixture-ts', message: "Type 'number' is not assignable to type 'string'." }

let buffer = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + size) return
    const row = JSON.parse(buffer.subarray(end + 4, end + 4 + size))
    buffer = buffer.subarray(end + 4 + size)
    if (row.method === 'exit') process.exit(0)
    if (row.id === undefined) continue
    if (process.env.FAILING_LSP_REQUEST_LOG) appendFileSync(process.env.FAILING_LSP_REQUEST_LOG, `${JSON.stringify({ method: row.method, params: row.params })}\n`)
    if (row.method === 'initialize') {
      if (mode === 'never-initialize') continue
      if (refuseInitialize) send({ id: row.id, error: { code: -32603, message: "no resolvable 'typescript' package from workspace root /fixture-project" } })
      else send({ id: row.id, result: { capabilities: { textDocumentSync: 1, diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } } } })
    } else if (row.method === 'textDocument/diagnostic') {
      if (mode === 'refuse-diagnostics') send({ id: row.id, error: { code: -32603, message: 'TypeScript diagnostic request failed: fixture compiler failure' } })
      else if (mode === 'never-answer-diagnostics') continue
      else send({ id: row.id, result: { kind: 'full', items: row.params?.textDocument?.uri?.endsWith('main.ts') ? [diagnostic] : [] } })
    } else if (row.method === 'shutdown') send({ id: row.id, result: null })
    else send({ id: row.id, result: null })
  }
})
