#!/usr/bin/env node
// Minimal stdio MCP server for the live-connect proof
// (scripts/mcp/prove-mcp-live-connect.ts). Newline-delimited JSON-RPC:
// initialize → tools capability, tools/list → one fixture tool, ping → {}.
// No dependencies, no network, exits when stdin closes.
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
    // OP-4 identity proof: record the client's initialize params so the
    // prover can assert the ON-WIRE clientInfo (name/title, no borrowed URL).
    if (process.env.MCP_FIXTURE_LOG) {
      try {
        appendFileSync(process.env.MCP_FIXTURE_LOG, JSON.stringify(msg.params ?? {}) + '\n')
      } catch {
        // never fail the handshake for the side log
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
    // MCP_FIXTURE_STALL_TOOLS_LIST=1: the handshake completes and the
    // discovery request is never answered (the launch-budget proof's
    // stalled-server shape).
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
    // Any other request (prompts/list, resources/list, …): empty catch-all.
    send({ jsonrpc: '2.0', id: msg.id, result: { prompts: [], resources: [] } })
  }
  // Notifications (notifications/initialized, …) are ignored.
})

rl.on('close', () => process.exit(0))
