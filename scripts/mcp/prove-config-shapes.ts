import assert from 'node:assert/strict'
import { join } from 'node:path'

const root = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const schemas = await import(join(root, 'integrations/mcp-shapes/mcpServerRecords.ts'))
const schemaWhere = ' | change the schema in src/integrations/mcp-shapes/mcpServerRecords.ts'
assert.deepEqual(schemas.ConfigScopeSchema().options, ['local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed'], 'ConfigScopeSchema options differ from the expected scopes' + schemaWhere)
assert.deepEqual(schemas.TransportSchema().options, ['stdio', 'sse', 'http', 'ws'], 'TransportSchema options differ from the expected transports' + schemaWhere)
assert.equal(schemas.McpServerConfigSchema(), schemas.McpServerConfigSchema(), 'McpServerConfigSchema must return the same singleton on every call' + schemaWhere)
const entry = schemas.McpServerConfigSchema()
assert.deepEqual(entry.parse({ command: 'echo', extra: true }), { command: 'echo', args: [] }, 'a stdio entry must default args to [] and strip unknown keys' + schemaWhere)
for (const type of ['sse', 'http']) {
  const value = { type, url: 'not-validated-as-a-url', headers: { a: 'b' }, headersHelper: 'helper', oauth: { clientId: 'client', callbackPort: 1234, authServerMetadataUrl: 'https://example.test/meta', extra: 'strip' }, toolPermissions: { t: 'ask' } }
  assert.deepEqual(entry.parse(value), { ...value, oauth: { clientId: 'client', callbackPort: 1234, authServerMetadataUrl: 'https://example.test/meta' } }, type + ' entry: fields must pass through and unknown oauth keys must be stripped' + schemaWhere)
  for (const url of ['http://example.test', 'HTTPS://example.test', 'not a URL']) assert.equal(entry.safeParse({ type, url: 'endpoint', oauth: { authServerMetadataUrl: url } }).success, false, type + ' entry must reject oauth.authServerMetadataUrl ' + url + schemaWhere)
  for (const port of [0, -1, 1.5]) assert.equal(entry.safeParse({ type, url: 'endpoint', oauth: { callbackPort: port } }).success, false, type + ' entry must reject oauth.callbackPort ' + port + schemaWhere)
}
assert.deepEqual(entry.parse({ type: 'ws', url: 'ws:endpoint', oauth: {}, toolPermissions: {}, headers: {} }), { type: 'ws', url: 'ws:endpoint', headers: {} }, 'a ws entry must drop empty oauth and toolPermissions and keep headers' + schemaWhere)
assert.deepEqual(entry.parse({ type: 'claudeai-proxy', url: 'endpoint', id: 'server', headers: {}, toolPermissions: { t: 'ask' } }), { type: 'claudeai-proxy', url: 'endpoint', id: 'server', toolPermissions: { t: 'ask' } }, 'a claudeai-proxy entry must drop headers and keep id and toolPermissions' + schemaWhere)
for (const value of [{}, { command: '' }, { type: 'other', command: 'echo' }, { type: 'http' }]) assert.equal(entry.safeParse(value).success, false, 'an entry must reject ' + JSON.stringify(value) + schemaWhere)
assert.deepEqual(schemas.McpJsonConfigSchema().parse({ mcpServers: { one: { command: 'echo' } }, extra: 'strip' }), { mcpServers: { one: { command: 'echo', args: [] } } }, 'McpJsonConfigSchema must strip unknown top-level keys' + schemaWhere)
assert.equal(schemas.McpJsonConfigSchema().safeParse({ mcpServers: { good: { command: 'echo' }, bad: { command: '' } } }).success, false, 'McpJsonConfigSchema must reject a document holding one invalid entry' + schemaWhere)
console.log('PASS MCP scopes, singleton schemas, transport fields, metadata validation and document admission')
