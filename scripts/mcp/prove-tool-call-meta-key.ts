#!/usr/bin/env bun
// gate-watch: src/services/mcp/client.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inProcessServerConfig, seatInProcessServer } from '../lib/mcpInProcess.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-meta-key-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

const REPO = resolve(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log("every MCP tools/call carries the tool-use id under Mercury's own _meta key")

const { Client } = await import('@modelcontextprotocol/client')
const { InMemoryTransport, Server } = await import('@modelcontextprotocol/server')
const mcp = await import('../../src/services/mcp/client.ts')
const KEY = (mcp as { MCP_TOOL_USE_ID_META_KEY?: string }).MCP_TOOL_USE_ID_META_KEY

check("the key is exported and Mercury-prefixed", KEY === 'mercury/toolUseId', String(KEY))

const seen: Array<Record<string, unknown> | undefined> = []
const server = new Server({ name: 'meta-prover', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler('tools/list', async () => ({
  tools: [{ name: 'echo', description: 'answers with the _meta it was sent', inputSchema: { type: 'object' } }],
}))
server.setRequestHandler('tools/call', async request => {
  seen.push(request.params._meta as Record<string, unknown> | undefined)
  return { content: [{ type: 'text', text: JSON.stringify(request.params._meta ?? null) }] }
})
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)
const client = new Client({ name: 'meta-prover-client', version: '1.0.0' }, { capabilities: {} })
await client.connect(clientTransport)
const connection = {
  type: 'connected' as const,
  name: 'meta-prover',
  client,
  capabilities: {},
  config: inProcessServerConfig('meta-prover'),
  cleanup: async () => {},
}
const unseat = seatInProcessServer(mcp, connection)

const parentFor = (id: string) => ({ message: { content: [{ type: 'tool_use', id, name: 'echo', input: {} }] } })
const withId = await mcp.callMCPToolWithUrlElicitationRetry({
  client: connection as never,
  tool: 'echo',
  args: { tag: 'one' },
  signal: new AbortController().signal,
  parentMessage: parentFor('toolu_meta_0001') as never,
} as never)
const meta = seen[0]
check('the server received a _meta block on the call', meta !== undefined && typeof meta === 'object', JSON.stringify(meta))
check("…carrying the tool-use id under 'mercury/toolUseId'", meta?.['mercury/toolUseId'] === 'toolu_meta_0001', JSON.stringify(meta))
check('…and the progress token beside it (the same id)', meta?.progressToken === 'toolu_meta_0001', JSON.stringify(meta))
check('the id rides under no other key', meta !== undefined && Object.keys(meta).sort().join(',') === 'mercury/toolUseId,progressToken', JSON.stringify(meta))
const echoed = Array.isArray(withId.content) ? ((withId.content[0] as { text?: string } | undefined)?.text ?? '') : ''
check("the server's echo of the wire shows the same key", echoed.includes('"mercury/toolUseId":"toolu_meta_0001"'), echoed)

const source = readFileSync(join(REPO, 'src/services/mcp/client.ts'), 'utf8')
check('the key is spelled once in the client, through the constant', (source.match(/mercury\/toolUseId/g) ?? []).length === 1 && /\[MCP_TOOL_USE_ID_META_KEY\]: toolUseId/.test(source))

unseat()
await client.close()
await server.close()

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ MCP TOOL-CALL META KEY GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ MCP TOOL-CALL META KEY RED (${failures} of ${checks} checks failed)`)
process.exit(1)
