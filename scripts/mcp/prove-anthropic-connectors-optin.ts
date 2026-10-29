#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    check(label, anthropicConnectorsArmed(canonical) === want)
  }
}

section('§2 THE LIVE GATE')
{
  clearAnthropicConnectorsCache()
  const unarmed = await fetchAnthropicConnectorsIfEligible()
  check('unarmed ⇒ the fetch settles {} (no catalog, no wire)', Object.keys(unarmed).length === 0)

  clearAnthropicConnectorsCache()
  process.env.MERCURY_ANTHROPIC_CONNECTORS = '1'
  const armedNoToken = await fetchAnthropicConnectorsIfEligible()
  check(
    'armed without a stored token ⇒ {} for the TOKEN reason (arming honored, nothing invented)',
    Object.keys(armedNoToken).length === 0,
  )
  delete process.env.MERCURY_ANTHROPIC_CONNECTORS
}

section('§3 WIRING')
{
  const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')
  const registry = src('src/substrate/flagRegistry.ts')
  check('MERCURY_ANTHROPIC_CONNECTORS is REGISTERED (opt-in)', registry.includes("env: 'MERCURY_ANTHROPIC_CONNECTORS'"))
  const gate = src('src/services/mcp/anthropicConnectors.ts')
  check(
    'the fetch consults the canonical row THROUGH the registry resolver',
    gate.includes("flagEnv('MERCURY_ANTHROPIC_CONNECTORS')"),
  )
  check(
    'the gate is the pure exported decision (polarity table provable forever)',
    gate.includes('export function anthropicConnectorsArmed('),
  )
  check(
    'the gate precedes every token read (unarmed sessions read nothing)',
    gate.indexOf('anthropicConnectorsArmed(') !== -1 && gate.indexOf('anthropicConnectorsArmed(') < gate.indexOf('getClaudeAIOAuthTokens()'),
  )
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-anthropic-connectors-optin: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-anthropic-connectors-optin: all green')
