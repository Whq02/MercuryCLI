#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const send = obj => process.stdout.write(JSON.stringify(obj) + '\n')
const rl = createInterface({ input: process.stdin })

rl.on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
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
        serverInfo: { name: 'fixsrv', version: '1.0.0' },
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
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: { prompts: [], resources: [] } })
  }
})

rl.on('close', () => process.exit(0))
