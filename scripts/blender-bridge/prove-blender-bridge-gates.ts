#!/usr/bin/env bun
// ============================================================================
//  scripts/blender-bridge/prove-blender-bridge-gates.ts
//  PROOF: the bridge's gate module — the one-switch arming ruling (rides
//  MERCURY_BLENDER), the catalog gate's .blend-context requirement (with its
//  bounded-walk cache), the port law, the token/addon-dir override seams,
//  and the registry rows' census (including the ruling's premise:
//  MERCURY_BLENDER stays additive-tier). Pure cpu — no sockets, no Blender,
//  no token file (the gates module itself never writes).
// ============================================================================

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  delete process.env.MERCURY_BLENDER
  delete process.env.MERCURY_BLENDER_BRIDGE_PORT
  delete process.env.MERCURY_BLENDER_BRIDGE_TOKEN
  delete process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR
}
resetEnv()

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const gates = await import('../../src/utils/blender/bridgeGates.js')
const { BLENDER_BRIDGE_DEFAULT_PORT } = await import('../../src/services/blender/bridgeProtocol.js')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-bridge-gates-'))
const proj = path.join(scratch, 'studio')
mkdirSync(proj, { recursive: true })
writeFileSync(path.join(proj, 'scene.blend'), 'BLENDER-fake')
const bare = path.join(scratch, 'bare')
mkdirSync(bare, { recursive: true })

section('1. the master polarity — the bridge rides MERCURY_BLENDER (the ruling)')
{
  resetEnv()
  check('flag unset ⇒ disarmed', gates.blenderBridgeEnabled() === false)
  process.env.MERCURY_BLENDER = '1'
  check('MERCURY_BLENDER=1 ⇒ armed (no second switch exists)', gates.blenderBridgeEnabled() === true)
  process.env.MERCURY_BLENDER = '0'
  check("'0' is not the opt-in spelling ⇒ disarmed", gates.blenderBridgeEnabled() === false)
}

section('2. the catalog gate — armed AND in a .blend context (bounded walk, cached)')
{
  resetEnv()
  gates._resetBlenderBridgeContextCacheForTesting()
  await runWithCwdOverride(proj, async () => {
    check('OFF beside a .blend ⇒ no tool', gates.blenderBridgeToolCatalogEnabled() === false)
  })
  process.env.MERCURY_BLENDER = '1'
  gates._resetBlenderBridgeContextCacheForTesting()
  await runWithCwdOverride(proj, async () => {
    check('armed beside a .blend ⇒ tool registers', gates.blenderBridgeToolCatalogEnabled() === true)
  })
  gates._resetBlenderBridgeContextCacheForTesting()
  await runWithCwdOverride(bare, async () => {
    check('armed in a blend-less dir ⇒ no ghost tool', gates.blenderBridgeToolCatalogEnabled() === false)
  })
  // The cache answers by cwd — a hit for one dir never leaks to another.
  gates._resetBlenderBridgeContextCacheForTesting()
  await runWithCwdOverride(proj, async () => {
    gates.blenderBridgeToolCatalogEnabled()
  })
  await runWithCwdOverride(bare, async () => {
    check(
      'the context cache is cwd-keyed (a .blend hit never leaks to a bare dir)',
      gates.blenderBridgeToolCatalogEnabled() === false,
    )
  })
  resetEnv()
  gates._resetBlenderBridgeContextCacheForTesting()
}

section('3. the port law — the vulcanPort grammar')
{
  resetEnv()
  check(`default ${BLENDER_BRIDGE_DEFAULT_PORT}`, gates.blenderBridgePort() === BLENDER_BRIDGE_DEFAULT_PORT)
  process.env.MERCURY_BLENDER_BRIDGE_PORT = '7124'
  check('a lawful override wins', gates.blenderBridgePort() === 7124)
  for (const bad of ['0', '65536', '-5', 'abc', '60.5', ' ']) {
    process.env.MERCURY_BLENDER_BRIDGE_PORT = bad
    check(`invalid '${bad}' falls back to the default`, gates.blenderBridgePort() === BLENDER_BRIDGE_DEFAULT_PORT)
  }
  resetEnv()
}

section('4. the override seams — token + addon-dir')
{
  resetEnv()
  check('token unset ⇒ undefined (the per-install file road)', gates.blenderBridgeTokenOverride() === undefined)
  process.env.MERCURY_BLENDER_BRIDGE_TOKEN = '   '
  check('token whitespace ⇒ undefined', gates.blenderBridgeTokenOverride() === undefined)
  process.env.MERCURY_BLENDER_BRIDGE_TOKEN = ' tok-override '
  check('a token value wins, trimmed', gates.blenderBridgeTokenOverride() === 'tok-override')
  check('addon-dir unset ⇒ undefined (the ladder road)', gates.blenderBridgeAddonDirOverride() === undefined)
  process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = ' /pin/addons '
  check('an addon-dir pin wins, trimmed', gates.blenderBridgeAddonDirOverride() === '/pin/addons')
  resetEnv()
}

section('5. registry census — the rows + the ruling’s premise')
{
  const port = getFlagSpec('MERCURY_BLENDER_BRIDGE_PORT')
  check(
    'PORT row: value-kind, gates-module consumer, default named',
    port?.kind === 'value' && port.consumer === 'src/utils/blender/bridgeGates.ts' && port.off === '6012',
  )
  const token = getFlagSpec('MERCURY_BLENDER_BRIDGE_TOKEN')
  check(
    'TOKEN row: value-kind, gates-module consumer, never-logged + per-install wording',
    token?.kind === 'value' &&
      token.consumer === 'src/utils/blender/bridgeGates.ts' &&
      /never logged/.test(token.summary) &&
      /per-INSTALL/.test(token.summary),
  )
  const addonDir = getFlagSpec('MERCURY_BLENDER_BRIDGE_ADDON_DIR')
  check(
    'ADDON_DIR row: value-kind, gates-module consumer, ladder named in off',
    addonDir?.kind === 'value' &&
      addonDir.consumer === 'src/utils/blender/bridgeGates.ts' &&
      /BLENDER_USER_SCRIPTS/.test(addonDir.off ?? '') &&
      /BLENDER_USER_RESOURCES/.test(addonDir.off ?? ''),
  )
  const master = getFlagSpec('MERCURY_BLENDER')
  check(
    "the ruling's premise pinned: MERCURY_BLENDER stays opt-in ADDITIVE (a tier flip must re-argue the one-switch ruling)",
    master?.kind === 'opt-in' && master.tier === 'additive',
    `kind=${master?.kind} tier=${master?.tier}`,
  )
}

console.log('\n' + (failures === 0 ? '✅ blender-bridge gates proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
