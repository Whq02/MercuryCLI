import assert from 'node:assert/strict'
import { join } from 'node:path'

const root = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const schemas = await import(join(root, 'services/mcp/types.ts'))
assert.deepEqual(schemas.ConfigScopeSchema().options, ['local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed'])
assert.deepEqual(schemas.TransportSchema().options, ['stdio', 'sse', 'http', 'ws'])
assert.equal(schemas.McpServerConfigSchema(), schemas.McpServerConfigSchema())
const entry = schemas.McpServerConfigSchema()
assert.deepEqual(entry.parse({ command: 'echo', extra: true }), { command: 'echo', args: [] })
for (const type of ['sse', 'http']) {
  const value = { type, url: 'not-validated-as-a-url', headers: { a: 'b' }, headersHelper: 'helper', oauth: { clientId: 'client', callbackPort: 1234, authServerMetadataUrl: 'https://example.test/meta', extra: 'strip' }, toolPermissions: { t: 'ask' } }
  assert.deepEqual(entry.parse(value), { ...value, oauth: { clientId: 'client', callbackPort: 1234, authServerMetadataUrl: 'https://example.test/meta' } })
  for (const url of ['http://example.test', 'HTTPS://example.test', 'not a URL']) assert.equal(entry.safeParse({ type, url: 'endpoint', oauth: { authServerMetadataUrl: url } }).success, false)
  for (const port of [0, -1, 1.5]) assert.equal(entry.safeParse({ type, url: 'endpoint', oauth: { callbackPort: port } }).success, false)
}
assert.deepEqual(entry.parse({ type: 'ws', url: 'ws:endpoint', oauth: {}, toolPermissions: {}, headers: {} }), { type: 'ws', url: 'ws:endpoint', headers: {} })
assert.deepEqual(entry.parse({ type: 'claudeai-proxy', url: 'endpoint', id: 'server', headers: {}, toolPermissions: { t: 'ask' } }), { type: 'claudeai-proxy', url: 'endpoint', id: 'server', toolPermissions: { t: 'ask' } })
for (const value of [{}, { command: '' }, { type: 'other', command: 'echo' }, { type: 'http' }]) assert.equal(entry.safeParse(value).success, false)
assert.deepEqual(schemas.McpJsonConfigSchema().parse({ mcpServers: { one: { command: 'echo' } }, extra: 'strip' }), { mcpServers: { one: { command: 'echo', args: [] } } })
assert.equal(schemas.McpJsonConfigSchema().safeParse({ mcpServers: { good: { command: 'echo' }, bad: { command: '' } } }).success, false)
console.log('PASS MCP scopes, singleton schemas, transport fields, metadata validation and document admission')
