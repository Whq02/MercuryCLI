#!/usr/bin/env bun
// ============================================================================
//  prove-server-filter-identity — per-server tool filtering matches on the
//  tool's recorded server identity, never only the rendered name prefix
//  (release-hardening audit rank 38).
//
//  The gap: wireSafeMcpToolName's shortening branch fires when the
//  normalized server name pushes the qualified name past the 64-character
//  wire cap — the emitted prefix is then built from the first 16
//  characters plus a digest, NOT the server's real prefix. But
//  filterToolsByServer and excludeToolsByServer matched on
//  name.startsWith(getMcpPrefix(server)). Every per-server operation
//  missed those tools: disabling the server from /mcp, a failed
//  connection, or removing it from config cleared the roster row but left
//  its tools in the session pool — the model could still call a tool
//  belonging to a server the user just turned off, and the call redialed
//  it. Reconnect refreshes appended duplicates (the unmatched old copies
//  were never removed), and the panel's per-server tool list showed none
//  of the server's tools.
//
//   L1 the premise: the long server's wire-safe name does NOT start with
//      its real prefix (the shortening is real)
//   L2 filter finds and exclude removes the shortened-name tool by its
//      mcpInfo identity
//   L3 controls: a normal-length server matches; another server's tools
//      are untouched; an info-less shape still rides the prefix fallback
//
//  PROVE_SRC names another checkout's src (the A/B control: L2 reads red
//  there).
// ============================================================================
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { filterToolsByServer, excludeToolsByServer } = await import(join(SRC, 'services/mcp/utils.ts'))
const { getMcpPrefix, wireSafeMcpToolName } = await import(join(SRC, 'services/mcp/mcpStringUtils.ts'))

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

// ── L1: the premise ────────────────────────────────────────────────────────
console.log('L1 the shortening is real')
{
  const wire = pool[0]!.name
  t('the long pair takes the shortened prefix', !wire.startsWith(getMcpPrefix(LONG_SERVER)), wire)
  t('the wire name fits the 64-character cap', wire.length <= 64, `${wire.length}`)
}

// ── L2: identity matching ──────────────────────────────────────────────────
console.log('L2 filter and exclude ride the recorded identity')
{
  const mine = filterToolsByServer(pool, LONG_SERVER)
  t('filter finds BOTH of the long server tools (the shortened spelling included)', mine.length === 2, `found=${mine.length}`)
  const rest = excludeToolsByServer(pool, LONG_SERVER)
  t('exclude removes both (nothing of the disabled server stays in the pool)', rest.length === 2 && rest.every(tool => tool.mcpInfo.serverName !== LONG_SERVER), `left=${rest.map(r => r.mcpInfo.serverName).join(',')}`)
}

// ── L3: controls ───────────────────────────────────────────────────────────
console.log('L3 controls')
{
  t('a normal-length server matches its tool', filterToolsByServer(pool, SHORT_SERVER).length === 1)
  t("another server's tools are untouched by exclude", excludeToolsByServer(pool, SHORT_SERVER).length === 3)
  const bare = [{ name: `${getMcpPrefix(SHORT_SERVER)}legacy_tool` }]
  t('an info-less shape still rides the prefix fallback', filterToolsByServer(bare as never, SHORT_SERVER).length === 1 && excludeToolsByServer(bare as never, SHORT_SERVER).length === 0)
}

console.log(failures === 0 ? 'SERVER FILTER IDENTITY: ALL PASS' : 'SERVER FILTER IDENTITY: RED')
process.exit(failures)
