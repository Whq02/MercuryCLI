#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.env.MCP_FIXTURE_SPAWN_LOG) {
  try {
    appendFileSync(process.env.MCP_FIXTURE_SPAWN_LOG, `${process.pid}\n`)
  } catch {
  }
}
if (process.env.MCP_FIXTURE_HOLD_FILE) {
  while (existsSync(process.env.MCP_FIXTURE_HOLD_FILE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
}
let mode = ''
if (process.env.MCP_FIXTURE_MODE_FILE) {
  try {
    mode = readFileSync(process.env.MCP_FIXTURE_MODE_FILE, 'utf8').trim()
  } catch {
    mode = ''
  }
}
if (mode === 'crash-at-start') process.exit(1)
let initialized = false

const send = obj => process.stdout.write(JSON.stringify(obj) + '\n')
const rl = createInterface({ input: process.stdin })

rl.on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (mode === 'exit-before-init' && !initialized && msg.id !== undefined && msg.method !== 'initialize') process.exit(1)
  if (msg.method === 'initialize') {
    initialized = true
    if (process.env.MCP_FIXTURE_LOG) {
      try {
        appendFileSync(process.env.MCP_FIXTURE_LOG, JSON.stringify(msg.params ?? {}) + '\n')
      } catch {
      }
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixsrv', version: '1.0.0', ...(process.env.MCP_FIXTURE_TITLE ? { title: process.env.MCP_FIXTURE_TITLE } : {}) },
      },
    })
    return
  }
  if (msg.method === 'tools/list') {
    if (process.env.MCP_FIXTURE_STALL_TOOLS_LIST === '1') return
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          ...(process.env.MCP_FIXTURE_MALFORMED_TOOLS ? [{ name: 'bad_schema', inputSchema: { type: 'array' } }, { name: 42, inputSchema: { type: 'object' } }] : []),
          {
            name: 'fix_ping',
            description: 'Fixture ping tool (live-connect proof).',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    })
    return
  }
  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }
  if (msg.method === 'prompts/list' || msg.method === 'resources/list' || msg.method === 'resources/templates/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { prompts: [], resources: [], resourceTemplates: [] } })
    return
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
  }
})

rl.on('close', () => process.exit(0))
