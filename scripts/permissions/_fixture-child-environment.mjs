import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

writeFileSync(process.env.M46_ENV_DUMP, JSON.stringify(process.env))
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'child-environment-fixture', version: '1.0.0' } } })
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })
    return
  }
  if (message.method === 'prompts/list' || message.method === 'resources/list' || message.method === 'resources/templates/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { prompts: [], resources: [], resourceTemplates: [] } })
    return
  }
  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
})
lines.on('close', () => process.exit(0))
