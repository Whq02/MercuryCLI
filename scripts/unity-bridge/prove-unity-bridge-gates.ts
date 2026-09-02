#!/usr/bin/env bun
// ============================================================================
//  scripts/unity-bridge/prove-unity-bridge-gates.ts
//  PROOF: the bridge's gate module — the one-switch arming ruling (rides
//  MERCURY_UNITY), the catalog gate's project requirement, the port law, the
//  token-override seam, and the registry rows' census (including the ruling's
//  premise: MERCURY_UNITY stays additive-tier). Pure cpu — no sockets, no
//  editor, no token file (the gates module itself never writes).
// ============================================================================

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const savedEnv = { ...process.env }
function resetEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
  delete process.env.MERCURY_UNITY
  delete process.env.MERCURY_UNITY_BRIDGE_PORT
  delete process.env.MERCURY_UNITY_BRIDGE_TOKEN
}
resetEnv()

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const gates = await import('../../src/utils/unity/bridgeGates.js')
const { UNITY_BRIDGE_DEFAULT_PORT } = await import('../../src/services/unity/bridgeProtocol.js')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'unity-bridge-gates-'))
const proj = path.join(scratch, 'game')
mkdirSync(path.join(proj, 'Assets'), { recursive: true })
mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true })
const bare = path.join(scratch, 'bare')
mkdirSync(bare, { recursive: true })

section('1. the master polarity — the bridge rides MERCURY_UNITY (the ruling)')
{
  resetEnv()
  check('flag unset ⇒ disarmed', gates.unityBridgeEnabled() === false)
  process.env.MERCURY_UNITY = '1'
  check('MERCURY_UNITY=1 ⇒ armed (no second switch exists)', gates.unityBridgeEnabled() === true)
  process.env.MERCURY_UNITY = '0'
  check("'0' is not the opt-in spelling ⇒ disarmed", gates.unityBridgeEnabled() === false)
}

section('2. the catalog gate — armed AND inside a Unity project')
{
  resetEnv()
  await runWithCwdOverride(proj, async () => {
    check('OFF inside a project ⇒ no tool', gates.unityBridgeToolCatalogEnabled() === false)
  })
  process.env.MERCURY_UNITY = '1'
  await runWithCwdOverride(proj, async () => {
    check('armed inside a project ⇒ tool registers', gates.unityBridgeToolCatalogEnabled() === true)
  })
  await runWithCwdOverride(bare, async () => {
    check('armed OUTSIDE a project ⇒ no ghost tool', gates.unityBridgeToolCatalogEnabled() === false)
  })
  resetEnv()
}

section('3. the port law — the vulcanPort grammar')
{
  resetEnv()
  check(`default ${UNITY_BRIDGE_DEFAULT_PORT}`, gates.unityBridgePort() === UNITY_BRIDGE_DEFAULT_PORT)
  process.env.MERCURY_UNITY_BRIDGE_PORT = '7123'
  check('a lawful override wins', gates.unityBridgePort() === 7123)
  for (const bad of ['0', '65536', '-5', 'abc', '60.5', ' ']) {
    process.env.MERCURY_UNITY_BRIDGE_PORT = bad
    check(`invalid '${bad}' falls back to the default`, gates.unityBridgePort() === UNITY_BRIDGE_DEFAULT_PORT)
  }
  resetEnv()
}

section('4. the token-override seam')
{
  resetEnv()
  check('unset ⇒ undefined (the per-project file road)', gates.unityBridgeTokenOverride() === undefined)
  process.env.MERCURY_UNITY_BRIDGE_TOKEN = '   '
  check('whitespace ⇒ undefined', gates.unityBridgeTokenOverride() === undefined)
  process.env.MERCURY_UNITY_BRIDGE_TOKEN = ' tok-override '
  check('a value wins, trimmed', gates.unityBridgeTokenOverride() === 'tok-override')
  resetEnv()
}

section('5. registry census — the rows + the ruling’s premise')
{
  const port = getFlagSpec('MERCURY_UNITY_BRIDGE_PORT')
  check(
    'PORT row: value-kind, gates-module consumer, default named',
    port?.kind === 'value' && port.consumer === 'src/utils/unity/bridgeGates.ts' && port.off === '6011',
  )
  const token = getFlagSpec('MERCURY_UNITY_BRIDGE_TOKEN')
  check(
    'TOKEN row: value-kind, gates-module consumer, never-logged wording',
    token?.kind === 'value' &&
      token.consumer === 'src/utils/unity/bridgeGates.ts' &&
      /never logged/.test(token.summary),
  )
  const master = getFlagSpec('MERCURY_UNITY')
  check(
    "the ruling's premise pinned: MERCURY_UNITY stays opt-in ADDITIVE (a tier flip must re-argue the one-switch ruling)",
    master?.kind === 'opt-in' && master.tier === 'additive',
    `kind=${master?.kind} tier=${master?.tier}`,
  )
}

console.log('\n' + (failures === 0 ? '✅ unity-bridge gates proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
