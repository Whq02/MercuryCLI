#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { filterToolsByServer, excludeToolsByServer } = await import(join(SRC, 'integrations/mcp/utils.ts'))
const { getMcpPrefix, wireSafeMcpToolName } = await import(join(SRC, 'integrations/mcp-shapes/mcpToolNames.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const LONG_SERVER = 'enterprise-connector-generated-by-vendor-provisioning-pipeline'
const SHORT_SERVER = 'github'
const OTHER_SERVER = 'linear'

const mkTool = (server: string, tool: string): { name: string; mcpInfo: { serverName: string; toolName: string } } => ({
  name: wireSafeMcpToolName(server, tool),
  mcpInfo: { serverName: server, toolName: tool },
})

const pool = [
  mkTool(LONG_SERVER, 'search_the_enterprise_document_graph_with_filters'),
  mkTool(LONG_SERVER, 'short'),
  mkTool(SHORT_SERVER, 'create_issue'),
  mkTool(OTHER_SERVER, 'update_ticket'),
]

console.log('L1 the shortening is real')
{
  const wire = pool[0]!.name
  t('the long pair takes the shortened prefix', !wire.startsWith(getMcpPrefix(LONG_SERVER)), `${wire} — wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts must shorten the prefix for a long server name`)
  t('the wire name fits the 64-character cap', wire.length <= 64, `${wire.length} — wireSafeMcpToolName in src/integrations/mcp-shapes/mcpToolNames.ts must keep the wire name within 64 characters`)
}

console.log('L2 filter and exclude ride the recorded identity')
{
  const mine = filterToolsByServer(pool, LONG_SERVER)
  t('filter finds BOTH of the long server tools (the shortened spelling included)', mine.length === 2, `found=${mine.length} — filterToolsByServer in src/integrations/mcp/utils.ts must match by the recorded mcpInfo.serverName, not only by name prefix`)
  const rest = excludeToolsByServer(pool, LONG_SERVER)
  t('exclude removes both (nothing of the disabled server stays in the pool)', rest.length === 2 && rest.every(tool => tool.mcpInfo.serverName !== LONG_SERVER), `left=${rest.map(r => r.mcpInfo.serverName).join(',')} — excludeToolsByServer in src/integrations/mcp/utils.ts must drop by the recorded mcpInfo.serverName, not only by name prefix`)
}

console.log('L3 controls')
{
  t('a normal-length server matches its tool', filterToolsByServer(pool, SHORT_SERVER).length === 1, 'filterToolsByServer in src/integrations/mcp/utils.ts must keep matching a server whose names are not shortened')
  t("another server's tools are untouched by exclude", excludeToolsByServer(pool, SHORT_SERVER).length === 3, 'excludeToolsByServer in src/integrations/mcp/utils.ts must remove only the named server')
  const bare = [{ name: `${getMcpPrefix(SHORT_SERVER)}legacy_tool` }]
  t('an info-less shape still rides the prefix fallback', filterToolsByServer(bare as never, SHORT_SERVER).length === 1 && excludeToolsByServer(bare as never, SHORT_SERVER).length === 0, 'filterToolsByServer and excludeToolsByServer in src/integrations/mcp/utils.ts must fall back to the name prefix when a tool has no mcpInfo')
}

console.log(failures === 0 ? 'SERVER FILTER IDENTITY: ALL PASS' : 'SERVER FILTER IDENTITY: RED')
process.exit(failures)
