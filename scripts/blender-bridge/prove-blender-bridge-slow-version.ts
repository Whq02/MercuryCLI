#!/usr/bin/env bun

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { withProofAccountHome } from '../lib/proofAccountHome.ts'
import { createFakeBlenderFixture } from './fake-blender.js'

const home = withProofAccountHome()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) console.log('    what to change: let the --version probe wait for a Blender that starts slowly, in src/integrations/blender-protocol/blenderProject.ts (probeBlenderVersion), which src/integrations/blender/addonHome.ts (resolveBlenderAddonHome) asks before src/integrations/blender/bridgeInstaller.ts (applyBlenderBridgeInstall, applyBlenderBridgeUninstall) can name the add-on home')
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

for (const k of [
  'MERCURY_BLENDER_BIN',
  'MERCURY_BLENDER_BRIDGE_PORT',
  'MERCURY_BLENDER_BRIDGE_TOKEN',
  'MERCURY_BLENDER_BRIDGE_ADDON_DIR',
  'BLENDER_USER_SCRIPTS',
  'BLENDER_USER_RESOURCES',
  'XDG_CONFIG_HOME',
  'APPDATA',
  'FAKE_BLENDER_VERSION',
]) {
  delete process.env[k]
}

const installer = await import('../../src/integrations/blender/bridgeInstaller.js')
const { BLENDER_BRIDGE_FILES } = await import('../../src/integrations/blender/bridgeFiles.generated.js')
const { BLENDER_ADDON_MODULE, resolveBlenderAddonHome } = await import('../../src/integrations/blender/addonHome.js')
const { _resetBlenderVersionProbeForTesting } = await import('../../src/integrations/blender-protocol/blenderProject.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-slow-version-'))
const fixture = createFakeBlenderFixture(path.join(scratch, 'bin'), { version: '5.3.0' })
const slow = path.join(scratch, 'cold', 'blender')
mkdirSync(path.dirname(slow), { recursive: true })
writeFileSync(
  slow,
  [
    '#!/usr/bin/env python3',
    'import os, sys, time',
    'if "--version" in sys.argv[1:]:',
    '    time.sleep(7)',
    `os.execv(${JSON.stringify(fixture.bin)}, [${JSON.stringify(fixture.bin)}] + sys.argv[1:])`,
    '',
  ].join('\n'),
)
chmodSync(slow, 0o755)
process.env.MERCURY_BLENDER = '1'
process.env.MERCURY_BLENDER_BIN = slow
const addonHome = resolveBlenderAddonHome({ version: '5.3.0' }).home?.path ?? ''
const dir = path.join(addonHome, BLENDER_ADDON_MODULE)

section('1. the default add-on home of this run lies in its scratch account home')
check('the add-on home for Blender 5.3 is inside the scratch account home, never a real one', addonHome.startsWith(home + path.sep), addonHome)
if (failures > 0) process.exit(1)

section('2. the first Blender call is the install, and this Blender answers --version only after about 7 s')
{
  const started = Date.now()
  const receipt = installer.applyBlenderBridgeInstall()
  const ms = Date.now() - started
  check(
    'the install waits for the slow --version and names the default add-on home it wrote into',
    ms >= 7_000 && receipt.startsWith(`installed ${BLENDER_BRIDGE_FILES.length} add-on files under ${dir}/ (`) && receipt.includes('home source: default)'),
    `${ms} ms · ${receipt.split('\n')[0]}`,
  )
  const status = installer.blenderBridgeInstallStatus(addonHome)
  check('the add-on is on disk in that home, every file as bundled', status.installed && status.digestMatch)
}

section('3. a minute later the first Blender call is the uninstall, and --version is slow again')
{
  _resetBlenderVersionProbeForTesting()
  const started = Date.now()
  const answer = installer.applyBlenderBridgeUninstall()
  const ms = Date.now() - started
  check(
    'the uninstall waits for the slow --version, finds the installed add-on and removes it',
    ms >= 7_000 && answer.startsWith(`${BLENDER_ADDON_MODULE} removed from ${addonHome} (`) && !existsSync(dir),
    `${ms} ms · ${answer}`,
  )
}

rmSync(scratch, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? '✅ blender-bridge slow --version proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
