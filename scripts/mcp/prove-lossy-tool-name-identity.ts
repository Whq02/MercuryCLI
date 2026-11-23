import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildMcpToolName, getToolNameForPermissionCheck, wireSafeMcpToolName } from '../../src/integrations/mcp-shapes/mcpToolNames.ts'

const identities = [['srv', 'db.query'], ['srv', 'db_query'], ['s.rv', 'db_query'], ['s_rv', 'db_query'], ['srv', '名前'], ['srv', '__'], ['srv', 'x'.repeat(100)], ['srv', 'x'.repeat(99) + 'y'], ['s'.repeat(100), 'db.query']] as const
const names = identities.map(([server, tool]) => wireSafeMcpToolName(server, tool))
assert.equal(new Set(names).size, identities.length, 'different MCP identities must not normalize to one wire name; fix wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts so lossy names carry a digest of server and tool: ' + JSON.stringify(names))
for (const [i, [server, tool]] of identities.entries()) {
  const name = names[i]!
  assert.match(name, /^[A-Za-z0-9_-]{1,64}$/, `wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts must return 1 to 64 characters of A-Z a-z 0-9 _ - for ${server} / ${tool}, got ${name}`)
  assert.equal(wireSafeMcpToolName(server, tool), name, `wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts must be deterministic for ${server} / ${tool}`)
  const joined = `mcp__${server}__${tool}`
  if (joined !== buildMcpToolName(server, tool)) {
    const digest = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 6)
    assert(name.endsWith(`_${digest}`), `lossy names carry a digest of both original identity parts; fix wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts, got ${name}`)
  }
  assert.equal(getToolNameForPermissionCheck({ name, mcpInfo: { serverName: server, toolName: tool } }), buildMcpToolName(server, tool), `getToolNameForPermissionCheck in src/integrations/mcp-shapes/mcpToolNames.ts must return the buildMcpToolName spelling for ${server} / ${tool}, not the wire name ${name}`)
}
assert.equal(wireSafeMcpToolName('srv', 'db_query'), 'mcp__srv__db_query', 'wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts must leave an already-safe name plain')
assert.equal(wireSafeMcpToolName('srv', 'dash-tool'), 'mcp__srv__dash-tool', 'wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts must keep a dash in a tool name plain')
assert.equal(wireSafeMcpToolName('ext:filmcraft:app', 'craft_status'), 'mcp__ext_filmcraft_app__craft_status', "fix wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts; Mercury's own ext:<extension>:<server> names map one-to-one, so the wire name stays plain")
assert.equal(wireSafeMcpToolName('ext:kitchen-sink:fixture', 'fixture_read'), 'mcp__ext_kitchen-sink_fixture__fixture_read', 'wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts must map an ext:<extension>:<server> name with a dash to a plain wire name')
assert.match(wireSafeMcpToolName('ext:kitchen_sink:fixture', 'fixture_read'), /^mcp__ext_kitchen_sink_fixture__fixture_read_[0-9a-f]{6}$/, 'fix wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts; an ext name carrying its own underscore is lossy again and keeps the digest')
assert.match(wireSafeMcpToolName('ext:filmcraft:app', 'craft.status'), /_[0-9a-f]{6}$/, 'fix wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts; a tool segment that normalisation changes keeps the digest')
assert.notEqual(wireSafeMcpToolName('ext:a:b-c', 'x'), wireSafeMcpToolName('ext:a:b_c', 'x'), 'fix wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts; two ext identities one underscore apart never share a wire name')
console.log('PASS lossy MCP names keep their identity without changing permission names')
