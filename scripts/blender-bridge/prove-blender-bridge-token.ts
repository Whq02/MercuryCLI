#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
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

delete process.env.MERCURY_BLENDER_BRIDGE_TOKEN
delete process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR
const { ensureBlenderBridgeToken, readBlenderBridgeToken, blenderBridgeTokenPath } = await import('../../src/services/blender/bridgeToken.js')
const { resolveBlenderAddonHome, blenderVersionDir, BLENDER_ADDON_MODULE } = await import('../../src/services/blender/addonHome.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-bridge-token-'))
const addonHome = path.join(scratch, 'scripts', 'addons')
mkdirSync(addonHome, { recursive: true })

section('1. creation — inside the add-on dir, 64-hex, 0600')
{
  const file = blenderBridgeTokenPath(addonHome)
  check('path is <addonHome>/mercury_blender_bridge/token', file === path.join(addonHome, BLENDER_ADDON_MODULE, 'token'))
  check('read-only probe answers undefined before creation', readBlenderBridgeToken(addonHome) === undefined)
  check('the probe created nothing', !existsSync(file))
  const token = ensureBlenderBridgeToken(addonHome)
  check('64-hex token minted', /^[0-9a-f]{64}$/.test(token))
  check('file exists inside the add-on dir', existsSync(file))
  if (process.platform !== 'win32') {
    check('mode 0600 pinned', (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8))
  }
}

section('2. stability + regeneration')
{
  const again = ensureBlenderBridgeToken(addonHome)
  const first = readBlenderBridgeToken(addonHome)
  check('stable per install (concurrent sessions agree)', again === first && typeof first === 'string')
  writeFileSync(blenderBridgeTokenPath(addonHome), 'HAND-EDITED-GARBAGE\n')
  check('the probe refuses a malformed file', readBlenderBridgeToken(addonHome) === undefined)
  const regenerated = ensureBlenderBridgeToken(addonHome)
  check('ensure regenerates over garbage instead of trusting it', /^[0-9a-f]{64}$/.test(regenerated) && regenerated !== 'HAND-EDITED-GARBAGE')
  check('the regenerated token persists', readBlenderBridgeToken(addonHome) === regenerated)
}

section('3. the env override — wins, never written')
{
  const onDisk = readBlenderBridgeToken(addonHome)
  process.env.MERCURY_BLENDER_BRIDGE_TOKEN = 'override-tok'
  check('override wins for ensure', ensureBlenderBridgeToken(addonHome) === 'override-tok')
  check('override wins for the probe', readBlenderBridgeToken(addonHome) === 'override-tok')
  delete process.env.MERCURY_BLENDER_BRIDGE_TOKEN
  check('disk untouched by the override', readBlenderBridgeToken(addonHome) === onDisk)
  check('the file still carries the disk token, not the override', !readFileSync(blenderBridgeTokenPath(addonHome), 'utf8').includes('override-tok'))
}

section('4. the addon-home ladder — every arm through its seam')
{
  const pinDir = path.join(scratch, 'pinned-addons')
  mkdirSync(pinDir, { recursive: true })
  process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = pinDir
  const pinned = resolveBlenderAddonHome({ env: {} })
  check('a directory pin wins as source pin', pinned.home?.path === pinDir && pinned.home?.source === 'pin')
  process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = path.join(scratch, 'no-such-dir')
  const broken = resolveBlenderAddonHome({ env: {} })
  check('a broken pin refuses NAMING the pin (no silent fallback)',
    broken.home === undefined && /MERCURY_BLENDER_BRIDGE_ADDON_DIR/.test(broken.pinError ?? ''))
  delete process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR

  const scriptsArm = resolveBlenderAddonHome({ env: { BLENDER_USER_SCRIPTS: '/custom/scripts' } })
  check('BLENDER_USER_SCRIPTS ⇒ <it>/addons', scriptsArm.home?.path === path.join('/custom/scripts', 'addons') && scriptsArm.home?.source === 'blender-user-scripts')

  const resourcesArm = resolveBlenderAddonHome({ env: { BLENDER_USER_RESOURCES: '/custom/resources' } })
  check('BLENDER_USER_RESOURCES ⇒ <it>/scripts/addons',
    resourcesArm.home?.path === path.join('/custom/resources', 'scripts', 'addons') && resourcesArm.home?.source === 'blender-user-resources')

  check("versionDir: '5.2.1' ⇒ '5.2'", blenderVersionDir('5.2.1') === '5.2')
  check("versionDir: '4.5' ⇒ '4.5'", blenderVersionDir('4.5') === '4.5')
  check("versionDir: garbage ⇒ undefined", blenderVersionDir('nightly') === undefined)
  const mac = resolveBlenderAddonHome({ env: {}, platform: 'darwin', home: '/Users/op', version: '5.2.1' })
  check('darwin default: ~/Library/Application Support/Blender/5.2/scripts/addons',
    mac.home?.path === path.join('/Users/op', 'Library', 'Application Support', 'Blender', '5.2', 'scripts', 'addons') && mac.home?.source === 'default')
  const win = resolveBlenderAddonHome({ env: { APPDATA: 'C:\\Users\\op\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\op', version: '4.5.3' })
  check('win32 default rides %APPDATA%\\Blender Foundation\\Blender\\4.5\\scripts\\addons',
    win.home?.path === path.join('C:\\Users\\op\\AppData\\Roaming', 'Blender Foundation', 'Blender', '4.5', 'scripts', 'addons'))
  const linux = resolveBlenderAddonHome({ env: {}, platform: 'linux', home: '/home/op', version: '5.2.0' })
  check('linux default: ~/.config/blender/5.2/scripts/addons',
    linux.home?.path === path.join('/home/op', '.config', 'blender', '5.2', 'scripts', 'addons'))
  const xdg = resolveBlenderAddonHome({ env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'linux', home: '/home/op', version: '5.2.0' })
  check('linux honors XDG_CONFIG_HOME', xdg.home?.path === path.join('/xdg', 'blender', '5.2', 'scripts', 'addons'))

  process.env.MERCURY_BLENDER_BIN = path.join(scratch, 'no-such-blender')
  const noVersion = resolveBlenderAddonHome({ env: {} })
  check('an unresolvable version arm answers a reason, never a guess',
    noVersion.home === undefined && typeof noVersion.reason === 'string' && noVersion.reason.length > 0)
  delete process.env.MERCURY_BLENDER_BIN
}

console.log('\n' + (failures === 0 ? '✅ blender-bridge token proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
