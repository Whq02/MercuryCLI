import assert from 'node:assert/strict'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const { connectToServer, fetchToolsForClient, getToolDiscoveryFailure, clearServerCache } = await import('../../src/services/mcp/client.js')
const config: import('../../src/services/mcp/types.js').ScopedMcpServerConfig = { type: 'stdio', scope: 'dynamic', command: process.execPath, args: [join(import.meta.dir, '_fixture-stdio-server.mjs')], env: { MCP_FIXTURE_MALFORMED_TOOLS: '1', MCP_FIXTURE_TITLE: 'Fixture Tools' } }
const connection = await connectToServer('mixed-tools', config)
try {
  assert.equal(connection.type, 'connected')
  if (connection.type !== 'connected') throw new Error('fixture did not connect')
  const tools = await fetchToolsForClient(connection)
  const failures: string[] = []
  if (tools.length !== 1 || !tools[0]?.name.endsWith('fix_ping')) failures.push(`G7: malformed tools hid the valid tool (${tools.length} loaded)`)
  if (getToolDiscoveryFailure(connection.name) !== null) failures.push('G7: valid discovery was recorded as a server failure')
  if (connection.serverInfo?.title !== 'Fixture Tools') failures.push('G8: serverInfo.title was discarded')
  assert.deepEqual(failures, [])
  console.log('malformed MCP tool isolation and server title: PASS')
} finally {
  await clearServerCache('mixed-tools', config)
}
