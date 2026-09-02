#!/usr/bin/env bun
// prove-claudeai-optin — the claude.ai org-MCP autoload is OPT-IN
// behind the canonical registered row. Before the gate, the default was ON:
// any stored OAuth token carrying user:mcp_servers silently pulled the org
// catalog into every session, and the ONLY switch was the registry-less
// the ONE canonical spelling; no other name is read.
//
//   §1 the pure polarity table (the one canonical spelling;
//      unset = OFF).
//   §2 the live gate: unarmed ⇒ the fetch settles {} WITHOUT reading a
//      token or touching the wire; armed-but-tokenless ⇒ {} for the token
//      reason (the arming itself is honored).
//   §3 wiring: the registered row + the fetch consults BOTH spellings live.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'claudeai-optin-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_CLAUDEAI_MCP
delete process.env.MERCURY_CLAUDEAI_MCP
delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { claudeAiMcpArmed, fetchClaudeAIMcpConfigsIfEligible, clearClaudeAIMcpConfigsCache } = await import(
  '../../src/services/mcp/claudeai.ts'
)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 THE POLARITY TABLE')
{
  const rows: Array<[string | undefined, boolean, string]> = [
    [undefined, false, 'unset ⇒ OFF (the opt-in flip)'],
    ['1', true, 'canonical=1 ⇒ armed'],
    ['0', false, 'canonical=0 ⇒ off'],
    ['', false, 'empty canonical reads unset ⇒ off'],
    ['true', true, 'truthy spellings honored'],
  ]
  for (const [canonical, want, label] of rows) {
    check(label, claudeAiMcpArmed(canonical) === want)
  }
}

section('§2 THE LIVE GATE')
{
  clearClaudeAIMcpConfigsCache()
  const unarmed = await fetchClaudeAIMcpConfigsIfEligible()
  check('unarmed ⇒ the fetch settles {} (no catalog, no wire)', Object.keys(unarmed).length === 0)

  clearClaudeAIMcpConfigsCache()
  process.env.MERCURY_CLAUDEAI_MCP = '1'
  const armedNoToken = await fetchClaudeAIMcpConfigsIfEligible()
  check(
    'armed without a stored token ⇒ {} for the TOKEN reason (arming honored, nothing invented)',
    Object.keys(armedNoToken).length === 0,
  )
  delete process.env.MERCURY_CLAUDEAI_MCP

  clearClaudeAIMcpConfigsCache()
  process.env.ENABLE_CLAUDEAI_MCP_SERVERS = '1'
  const foreignOn = await fetchClaudeAIMcpConfigsIfEligible()
  check('the retired foreign spelling is IGNORED (truthy alone arms nothing)', Object.keys(foreignOn).length === 0)
  delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS
}

section('§3 WIRING')
{
  const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')
  const registry = src('src/substrate/flagRegistry.ts')
  check(
    'MERCURY_CLAUDEAI_MCP is REGISTERED (opt-in) and no foreign rung is documented',
    registry.includes("env: 'MERCURY_CLAUDEAI_MCP'") &&
      !registry.includes('ENABLE_CLAUDEAI_MCP_SERVERS'),
  )
  check(
    'the gate reads no foreign spelling',
    !src('src/services/mcp/claudeai.ts').includes('ENABLE_CLAUDEAI_MCP_SERVERS'),
  )
  const gate = src('src/services/mcp/claudeai.ts')
  check(
    'the fetch consults the canonical row THROUGH the registry resolver',
    gate.includes("flagEnv('MERCURY_CLAUDEAI_MCP')"),
  )
  check(
    'the gate is the pure exported decision (polarity table provable forever)',
    gate.includes('export function claudeAiMcpArmed('),
  )
  check(
    'the gate precedes every token read (unarmed sessions read nothing)',
    gate.indexOf('claudeAiMcpArmed(') !== -1 && gate.indexOf('claudeAiMcpArmed(') < gate.indexOf('getClaudeAIOAuthTokens()'),
  )
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-claudeai-optin: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-claudeai-optin: all green')
