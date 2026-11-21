#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'connectors-optin-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_ANTHROPIC_CONNECTORS
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { anthropicConnectorsArmed, fetchAnthropicConnectorsIfEligible, clearAnthropicConnectorsCache } = await import(
  '../../src/services/mcp/anthropicConnectors.ts'
)
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = '', fixHint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && fixHint ? ' — fix: ' + fixHint : ''}`)
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
    check(label, anthropicConnectorsArmed(canonical) === want, '', 'anthropicConnectorsArmed in src/services/mcp/anthropicConnectors.ts must be false for undefined, empty and 0, and true for 1 and true')
  }
}

section('§2 THE LIVE GATE')
{
  clearAnthropicConnectorsCache()
  const unarmed = await fetchAnthropicConnectorsIfEligible()
  check('unarmed ⇒ the fetch settles {} (no catalog, no wire)', Object.keys(unarmed).length === 0, '', 'fetchAnthropicConnectorsIfEligible in src/services/mcp/anthropicConnectors.ts must return {} before any token read or request when anthropicConnectorsArmed is false')

  clearAnthropicConnectorsCache()
  process.env.MERCURY_ANTHROPIC_CONNECTORS = '1'
  const armedNoToken = await fetchAnthropicConnectorsIfEligible()
  check(
    'armed without a stored token ⇒ {} for the TOKEN reason (arming honored, nothing invented)',
    Object.keys(armedNoToken).length === 0,
    '',
    'fetchAnthropicConnectorsIfEligible in src/services/mcp/anthropicConnectors.ts must return {} when getClaudeAIOAuthTokens has no access token',
  )
  delete process.env.MERCURY_ANTHROPIC_CONNECTORS
}

section('§3 WIRING')
{
  check('MERCURY_ANTHROPIC_CONNECTORS is REGISTERED (opt-in)', getFlagSpec('MERCURY_ANTHROPIC_CONNECTORS') !== undefined, '', 'register MERCURY_ANTHROPIC_CONNECTORS as a flag in src/substrate/flags/mcp.ts')
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-anthropic-connectors-optin: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-anthropic-connectors-optin: all green')
