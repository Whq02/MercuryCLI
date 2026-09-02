#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-mcp-gauge-sources.ts — doctor's MCP gauge sees the same
//  configuration the mcp verbs see (FC-148). The gauge read only the user
//  scope and the global store's per-project slice, so doctor said "no MCP
//  servers configured" in a directory whose .mcp.json mcp list spawns
//  seconds later. The project scope now joins the census, gated exactly
//  like the assembly (FC-144: an untrusted headless run loads none, so the
//  gauge counts none).
//
//  Run: ~/.bun/bin/bun run scripts/mcp/prove-mcp-gauge-sources.ts
// ============================================================================
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'gauge-src-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'gauge-src-proj-')))
writeFileSync(join(PROJ, '.mcp.json'), JSON.stringify({ mcpServers: { fixsrv: { command: 'node', args: [] } } }))

const { setCwd } = await import('../../src/utils/Shell.js')
const { setIsInteractive, setSessionTrustAccepted, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.js')
const { resetTrustDialogAcceptedCacheForTesting } = await import('../../src/utils/config/trust.js')
const { mcpGauge } = await import('../../src/utils/cockpit/mcpGauge.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
setCwd(PROJ)
setOriginalCwd(PROJ)
setProjectRoot(PROJ)

console.log('§1 the trusted census carries the .mcp.json server')
{
  setIsInteractive(false)
  setSessionTrustAccepted(true)
  resetTrustDialogAcceptedCacheForTesting()
  const gauge = mcpGauge()
  const names = gauge.state === 'live' ? gauge.data.servers.map(s => s.name) : []
  check(
    "the gauge lists the checkout's server (was: no MCP servers configured)",
    gauge.state === 'live' && names.includes('fixsrv'),
    `${gauge.state}: ${JSON.stringify(names)}`,
  )
}

console.log('§2 the untrusted headless census matches the assembly (FC-144 parity)')
{
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
  const gauge = mcpGauge()
  const names = gauge.state === 'live' ? gauge.data.servers.map(s => s.name) : []
  check(
    'untrusted headless counts none from the checkout (nothing will load)',
    !names.includes('fixsrv'),
    `${gauge.state}: ${JSON.stringify(names)}`,
  )
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-mcp-gauge-sources: all green' : `\nprove-mcp-gauge-sources: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
