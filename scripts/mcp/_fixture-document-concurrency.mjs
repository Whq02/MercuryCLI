import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const record = type => appendFileSync(process.argv[2], JSON.stringify({ type, pid: process.pid, at: Date.now() }) + '\n')
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    record('start')
    setTimeout(() => {
      record('end')
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'document-concurrency-fixture', version: '1.0.0' } } })
    }, 200)
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })
    return
  }
  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
})
setTimeout(() => process.exit(0), 1000)
