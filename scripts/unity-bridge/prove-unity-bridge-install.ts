#!/usr/bin/env bun
// ============================================================================
//  scripts/unity-bridge/prove-unity-bridge-install.ts
//  PROOF: the installer's three artifacts and nothing else — the package
//  files under Packages/ (the embedded law: no manifest edit anywhere), the
//  Library/ token, the OPTIONAL port-alignment file that appears exactly
//  when Mercury's port leaves the default and disappears when it returns;
//  status honesty including drift-on-tamper and refresh-on-reinstall; the
//  describe surface's rows (flag, package, token, reachability against the
//  fake bridge, PORT MISMATCH). Scratch trees + one loopback fake only.
// ============================================================================

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

delete process.env.MERCURY_UNITY
delete process.env.MERCURY_UNITY_BRIDGE_PORT
delete process.env.MERCURY_UNITY_BRIDGE_TOKEN

const installer = await import('../../src/services/unity/bridgeInstaller.js')
const { UNITY_BRIDGE_FILES } = await import('../../src/services/unity/bridgeFiles.generated.js')
const { unityBridgeTokenPath } = await import('../../src/services/unity/bridgeToken.js')
const { startFakeUnityBridge } = await import('./fake-bridge.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'unity-bridge-install-'))
const proj = path.join(scratch, 'game')
mkdirSync(path.join(proj, 'Assets'), { recursive: true })
mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true })
const packageRoot = path.join(proj, 'Packages', 'com.mercury.unity-bridge')
const settingsFile = path.join(proj, 'ProjectSettings', 'MercuryUnityBridge.json')

section('1. install — the three artifacts, nothing else')
{
  check('fresh tree: NOT installed', installer.unityBridgeInstallStatus(proj).installed === false)
  const receipt = installer.applyUnityBridgeInstall(proj)
  check('receipt names the count + embedded law', new RegExp(`installed ${UNITY_BRIDGE_FILES.length} package files`).test(receipt) && /no manifest entry needed/.test(receipt))
  check('every bundled file landed byte-identical', UNITY_BRIDGE_FILES.every(f => {
    try {
      return readFileSync(path.join(packageRoot, f.path), 'utf8') === f.content
    } catch {
      return false
    }
  }))
  check('token file written', existsSync(unityBridgeTokenPath(proj)))
  check('NO port-alignment file at the default port', !existsSync(settingsFile))
  check('no manifest.json was created or touched', !existsSync(path.join(proj, 'Packages', 'manifest.json')))
  const status = installer.unityBridgeInstallStatus(proj)
  check('status: installed + digestMatch', status.installed && status.digestMatch)
}

section('2. the port-alignment file — appears off-default, leaves on return')
{
  process.env.MERCURY_UNITY_BRIDGE_PORT = '7123'
  const receipt = installer.applyUnityBridgeInstall(proj)
  check('off-default install writes the alignment file', existsSync(settingsFile) && /7123/.test(receipt))
  check('readProjectBridgePort answers the package half', installer.readProjectBridgePort(proj) === 7123)
  delete process.env.MERCURY_UNITY_BRIDGE_PORT
  const receipt2 = installer.applyUnityBridgeInstall(proj)
  check('back-to-default install removes it, saying so', !existsSync(settingsFile) && /removed/.test(receipt2))
  check('readProjectBridgePort answers undefined without the file', installer.readProjectBridgePort(proj) === undefined)
}

section('3. drift honesty — tamper flips digestMatch, reinstall refreshes')
{
  const target = path.join(packageRoot, 'Editor', 'BridgeServer.cs')
  writeFileSync(target, readFileSync(target, 'utf8') + '\n// tampered\n')
  const tampered = installer.unityBridgeInstallStatus(proj)
  check('a tampered file flips digestMatch (still installed)', tampered.installed && !tampered.digestMatch)
  installer.applyUnityBridgeInstall(proj)
  check('reinstall refreshes to byte-match', installer.unityBridgeInstallStatus(proj).digestMatch === true)
}

section('4. describe — the status rows, against the fake bridge')
{
  const off = await installer.describeUnityBridgeStatus(proj)
  check('flag row honest when OFF', /flag: OFF/.test(off))
  check('package row: installed + matching', /package: installed, matches the bundled version/.test(off))
  check('token row present', /token file: present/.test(off))
  check('unreachable row carries the teaching hint', /not answering on 127\.0\.0\.1:6011/.test(off) && /unity_bridge_install/.test(off))
  check('client row unavailable outside an armed project cwd', /client: unavailable/.test(off))

  const fake = await startFakeUnityBridge()
  process.env.MERCURY_UNITY = '1'
  process.env.MERCURY_UNITY_BRIDGE_PORT = String(fake.port)
  const on = await installer.describeUnityBridgeStatus(proj)
  check('flag row honest when armed', /flag: armed \(MERCURY_UNITY\)/.test(on))
  check('reachability row answers against the live fake', new RegExp(`answering on 127\\.0\\.0\\.1:${fake.port}`).test(on))
  check('PORT MISMATCH row: Mercury off-default, package on default', /PORT MISMATCH: Mercury dials \d+ but the package listens on 6011/.test(on))
  await fake.close()
  delete process.env.MERCURY_UNITY
  delete process.env.MERCURY_UNITY_BRIDGE_PORT
}

section('5. uninstall — everything gone, honestly')
{
  writeFileSync(packageRoot + '.meta', 'fileFormatVersion: 2\n') // the editor-generated stray
  process.env.MERCURY_UNITY_BRIDGE_PORT = '7123'
  installer.applyUnityBridgeInstall(proj) // re-create the alignment file
  delete process.env.MERCURY_UNITY_BRIDGE_PORT
  const receipt = installer.applyUnityBridgeUninstall(proj)
  check('package dir removed', !existsSync(packageRoot))
  check('the stray dir .meta removed', !existsSync(packageRoot + '.meta'))
  check('token removed', !existsSync(unityBridgeTokenPath(proj)))
  check('alignment file removed, receipt says so', !existsSync(settingsFile) && /port-alignment file removed/.test(receipt))
  check('Assets/ untouched', readdirSync(path.join(proj, 'Assets')).length === 0)
  const again = installer.applyUnityBridgeUninstall(proj)
  check('a second uninstall is honest about absence', /was not installed/.test(again))
}

console.log('\n' + (failures === 0 ? '✅ unity-bridge install proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
