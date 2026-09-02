#!/usr/bin/env node
// Stdio MCP fixture that SPAWNS A HELPER CHILD (the npx / worker shape) for
// the disable-disconnects proof: newline-delimited JSON-RPC — initialize →
// tools capability — while a `sleep 600` helper runs beside it. The helper's
// pid is written to MCP_SPAWNER_PIDS so the prover can assert BOTH die.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const helper = spawn('sleep', ['600'], { stdio: 'ignore' })
if (process.env.MCP_SPAWNER_PIDS) {
  try {
    writeFileSync(process.env.MCP_SPAWNER_PIDS, `${process.pid}:${helper.pid}`)
  } catch {
    // never fail the handshake for the side log
  }
}

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
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'spawnersrv', version: '1.0.0' },
      },
    })
    return
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } })
    return
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
