#!/usr/bin/env node
// ============================================================================
//  scripts/core-runtime/mcp-stub-server.mjs — a dependency-free stdio MCP
//  server for the boot lane's first-frame rig (prove-boot-mcp-independence).
//
//  Speaks the MCP stdio framing (one JSON-RPC 2.0 message per line on
//  stdin/stdout) well enough for the product's client to connect, list one
//  tool, and call it. Its whole purpose is to misbehave on command:
//
//    --delay-ms <n>        answer `initialize` only after n milliseconds
//    --never               never answer `initialize` (stay alive, say nothing)
//    --spawn-marker <path> append "<pid> <epoch-ms>" to <path> at startup, so
//                          a prover can count how many times the product
//                          spawned this server
//
//  Everything else answers immediately. Exits when stdin closes.
// ============================================================================
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const flag = (name) => argv.indexOf(name)
const valueOf = (name) => {
  const i = flag(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const delayMs = Number(valueOf('--delay-ms') ?? 0)
const never = flag('--never') >= 0
const marker = valueOf('--spawn-marker')
const serverName = valueOf('--name') ?? 'mcp-stub'

if (marker) {
  try {
    appendFileSync(marker, `${process.pid} ${Date.now()}\n`)
  } catch {
    // A marker the prover cannot read is the prover's failure, not ours.
  }
}

const out = (message) => {
  process.stdout.write(JSON.stringify(message) + '\n')
}
const reply = (id, result) => out({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } })

const TOOL = {
  name: 'stub_echo',
  description: 'Echoes its input back (boot-rig stub).',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
}

function handle(message) {
  if (typeof message !== 'object' || message === null) return
  const { id, method, params } = message
  if (method === undefined) return // a response to something we never asked
  switch (method) {
    case 'initialize': {
      if (never) return
      const result = {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: serverName, version: '0.0.0' },
      }
      if (delayMs > 0) setTimeout(() => reply(id, result), delayMs)
      else reply(id, result)
      return
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, { tools: [TOOL] })
      return
    case 'prompts/list':
      reply(id, { prompts: [] })
      return
    case 'resources/list':
      reply(id, { resources: [] })
      return
    case 'resources/templates/list':
      reply(id, { resourceTemplates: [] })
      return
    case 'tools/call':
      reply(id, {
        content: [{ type: 'text', text: String(params?.arguments?.text ?? '') }],
        isError: false,
      })
      return
    default:
      if (id !== undefined) fail(id, -32601, `Method not found: ${method}`)
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  if (Array.isArray(message)) message.forEach(handle)
  else handle(message)
})
lines.on('close', () => process.exit(0))
process.stdin.on('end', () => process.exit(0))
