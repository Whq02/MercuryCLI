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

const nullConfig: import('../../src/services/mcp/types.js').ScopedMcpServerConfig = { type: 'stdio', scope: 'dynamic', command: process.execPath, args: [join(import.meta.dir, '_fixture-stdio-server.mjs')], env: { MCP_FIXTURE_NULL_METADATA_TOOLS: '1' } }
const nullConnection = await connectToServer('null-metadata-tools', nullConfig)
try {
  assert.equal(nullConnection.type, 'connected')
  if (nullConnection.type !== 'connected') throw new Error('fixture did not connect')
  const tools = await fetchToolsForClient(nullConnection)
  const names = tools.map(tool => (tool as { mcpInfo?: { toolName: string } }).mcpInfo?.toolName ?? tool.name).sort()
  const failures: string[] = []
  const kept = ['fix_ping', 'null_annotation_title', 'null_annotations', 'null_description', 'null_properties', 'null_title_meta_icons']
  if (JSON.stringify(names) !== JSON.stringify(kept)) failures.push(`G9: a tool whose optional metadata is null was dropped or a malformed one kept (${names.join(', ')})`)
  const described = tools.find(tool => (tool as { mcpInfo?: { toolName: string } }).mcpInfo?.toolName === 'null_description')
  if (described !== undefined && typeof (await described.description?.({} as never, {} as never)) !== 'string') failures.push('G9: a null description did not read as an empty one')
  const titled = tools.find(tool => (tool as { mcpInfo?: { toolName: string } }).mcpInfo?.toolName === 'null_annotation_title')
  if (titled !== undefined && titled.isReadOnly?.({} as never) !== true) failures.push('G9: the annotations beside a null title were lost')
  if (getToolDiscoveryFailure(nullConnection.name) !== null) failures.push('G9: null metadata was recorded as a server failure')
  assert.deepEqual(failures, [])
  console.log('null optional tool metadata read as absent, malformed tools still isolated: PASS')
} finally {
  await clearServerCache('null-metadata-tools', nullConfig)
}
