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
  '../../src/integrations/mcp/anthropicConnectors.ts'
)
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
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
    check(label, anthropicConnectorsArmed(canonical) === want, '', 'fix anthropicConnectorsArmed in src/integrations/mcp/anthropicConnectors.ts so this MERCURY_ANTHROPIC_CONNECTORS value arms or disarms as the row says')
  }
}

section('§2 THE LIVE GATE')
{
  clearAnthropicConnectorsCache()
  const unarmed = await fetchAnthropicConnectorsIfEligible()
  check('unarmed ⇒ the fetch settles {} (no catalog, no wire)', Object.keys(unarmed).length === 0, '', 'fetchAnthropicConnectorsIfEligible in src/integrations/mcp/anthropicConnectors.ts must return {} before any fetch when anthropicConnectorsArmed is false')

  clearAnthropicConnectorsCache()
  process.env.MERCURY_ANTHROPIC_CONNECTORS = '1'
  const armedNoToken = await fetchAnthropicConnectorsIfEligible()
  check(
    'armed without a stored token ⇒ {} for the TOKEN reason (arming honored, nothing invented)',
    Object.keys(armedNoToken).length === 0,
    '',
    'fetchAnthropicConnectorsIfEligible in src/integrations/mcp/anthropicConnectors.ts must return {} when armed but no access token is stored',
  )
  delete process.env.MERCURY_ANTHROPIC_CONNECTORS
}

section('§3 WIRING')
{
  check('MERCURY_ANTHROPIC_CONNECTORS is REGISTERED (opt-in)', getFlagSpec('MERCURY_ANTHROPIC_CONNECTORS') !== undefined, '', 'add a MERCURY_ANTHROPIC_CONNECTORS row to FLAG_REGISTRY (the mcp group of flag rows)')
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-anthropic-connectors-optin: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-anthropic-connectors-optin: all green')
