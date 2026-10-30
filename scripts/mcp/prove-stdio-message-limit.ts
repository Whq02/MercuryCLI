#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mcp-stdio-limit-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
process.env.MERCURY_MCP_STDIO_MESSAGE_MB = '2'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { connectToServer, callMCPToolWithUrlElicitationRetry, clearServerCache, mcpStdioMaxMessageBytes, DEFAULT_MCP_STDIO_MESSAGE_MB } = await import('../../src/services/mcp/client.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — stdio message limit prover exceeded 90s')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

console.log('a stdio server\'s single message may be large; one over the limit names the limit, never an unknown outcome')

console.log('\n[1] the knob')
check('the knob is read in MiB', mcpStdioMaxMessageBytes() === 2 * 1024 * 1024, String(mcpStdioMaxMessageBytes()))
process.env.MERCURY_MCP_STDIO_MESSAGE_MB = 'nonsense'
check('a value that is not a positive number falls back to the default', mcpStdioMaxMessageBytes() === DEFAULT_MCP_STDIO_MESSAGE_MB * 1024 * 1024)
delete process.env.MERCURY_MCP_STDIO_MESSAGE_MB
check('the default is above the SDK\'s 10 MiB', mcpStdioMaxMessageBytes() > 10 * 1024 * 1024 && DEFAULT_MCP_STDIO_MESSAGE_MB === 64)
process.env.MERCURY_MCP_STDIO_MESSAGE_MB = '2'

const script = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const send = o => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', line => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined) return
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'big', version: '1' } } })
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { mb: { type: 'number' } } } }] } })
  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'y'.repeat(Math.floor((m.params.arguments?.mb ?? 1) * 1024 * 1024)) }] } })
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} })
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
})
`
const config: import('../../src/services/mcp/types.ts').ScopedMcpServerConfig = { type: 'stdio', scope: 'dynamic', command: process.execPath, args: ['-e', script] }
const call = (connection: import('../../src/services/mcp/types.ts').MCPServerConnection, mb: number) =>
  callMCPToolWithUrlElicitationRetry({ client: connection, tool: 'echo', args: { mb }, signal: new AbortController().signal })
    .then(result => ({ ok: true as const, length: JSON.stringify(result.content).length }), (error: Error) => ({ ok: false as const, message: error.message }))

console.log('\n[2] under a 2 MiB limit')
const connection = await connectToServer('big-lines', config)
try {
  check('the server connects', connection.type === 'connected')
  const small = await call(connection, 1)
  check('a 1 MiB answer arrives whole', small.ok && small.length > 1024 * 1024, JSON.stringify(small).slice(0, 120))
  const big = await call(connection, 3)
  check('a 3 MiB answer is refused with the limit named', !big.ok && big.message.includes('over 2MB') && big.message.includes('stdio message limit'), JSON.stringify(big).slice(0, 240))
  check('…and the knob that raises it', !big.ok && big.message.includes('MERCURY_MCP_STDIO_MESSAGE_MB'))
  check('…never the bare unknown outcome', !big.ok && !big.message.startsWith('MCP tool "echo" on server "big-lines": unknown outcome'))
  const after = await call(connection, 1)
  check('the next small call answers again (the server was reconnected)', after.ok && after.length > 1024 * 1024, JSON.stringify(after).slice(0, 120))
} finally {
  await clearServerCache('big-lines', config)
}

clearTimeout(watchdog)
console.log(failures === 0 ? '\nPASS prove-stdio-message-limit' : `\nFAIL prove-stdio-message-limit (${failures})`)
process.exit(failures === 0 ? 0 : 1)
