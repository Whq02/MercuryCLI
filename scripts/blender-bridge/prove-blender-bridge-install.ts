#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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
  for (const k of [
    'MERCURY_BLENDER',
    'MERCURY_BLENDER_BIN',
    'MERCURY_BLENDER_BRIDGE_PORT',
    'MERCURY_BLENDER_BRIDGE_TOKEN',
    'MERCURY_BLENDER_BRIDGE_ADDON_DIR',
    'BLENDER_USER_SCRIPTS',
    'BLENDER_USER_RESOURCES',
  ]) {
    delete process.env[k]
  }
}
resetEnv()

const installer = await import('../../src/services/blender/bridgeInstaller.js')
const { BLENDER_BRIDGE_FILES } = await import('../../src/services/blender/bridgeFiles.generated.js')
const { BLENDER_ADDON_MODULE } = await import('../../src/services/blender/addonHome.js')
const { getBlenderBridgeClient, resetBlenderBridgeClientForTest } = await import('../../src/services/blender/bridgeClient.js')
const { BlenderTool } = await import('../../src/tools/BlenderTool/BlenderTool.js')
const { startFakeBlenderBridge } = await import('./fake-bridge.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-bridge-install-'))
const noBlender = path.join(scratch, 'no-such-blender')
process.env.MERCURY_BLENDER_BIN = noBlender
const home = path.join(scratch, 'addons')
mkdirSync(home, { recursive: true })
process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = home
const dir = path.join(home, BLENDER_ADDON_MODULE)

section('1. install — the artifacts, all inside the add-on dir')
{
  const receipt = installer.applyBlenderBridgeInstall()
  check('receipt names the file count + home source', receipt.includes(`installed ${BLENDER_BRIDGE_FILES.length} add-on files`) && receipt.includes('home source: pin'))
  check('receipt teaches BOTH enable roads (Preferences + the one-liner) and names the module', /Preferences > Add-ons/.test(receipt) && /addon_enable\(module='mercury_blender_bridge'\)/.test(receipt) && /save_userpref/.test(receipt))
  check('receipt says Mercury never automates enabling', /never automates/.test(receipt))
  check('every bundled file landed byte-for-byte', BLENDER_BRIDGE_FILES.every(f => {
    try {
      return readFileSync(path.join(home, f.path), 'utf8') === f.content
    } catch {
      return false
    }
  }))
  const token = readFileSync(path.join(dir, 'token'), 'utf8').trim()
  check('token minted inside the add-on dir, 64-hex', /^[0-9a-f]{64}$/.test(token))
  if (process.platform !== 'win32') {
    check('token mode 0600', (statSync(path.join(dir, 'token')).mode & 0o777) === 0o600)
  }
  check('NO config.json at the default port', !existsSync(path.join(dir, 'config.json')))
  const status = installer.blenderBridgeInstallStatus(home)
  check('status: installed + digest match', status.installed && status.digestMatch)
}

section('2. the port-alignment law — config.json appears off-default, leaves on return')
{
  process.env.MERCURY_BLENDER_BRIDGE_PORT = '7999'
  const receipt = installer.applyBlenderBridgeInstall()
  check('receipt names the alignment', receipt.includes('config.json set to 7999'))
  check('config.json carries the port', installer.readAddonBridgePort(home) === 7999)
  delete process.env.MERCURY_BLENDER_BRIDGE_PORT
  const back = installer.applyBlenderBridgeInstall()
  check('returning to the default removes config.json', back.includes('config.json removed') && !existsSync(path.join(dir, 'config.json')))
  check('readAddonBridgePort answers undefined without the file', installer.readAddonBridgePort(home) === undefined)
}

section('3. drift — detected honestly, healed by reinstall')
{
  writeFileSync(path.join(dir, 'state.py'), '# tampered\n')
  const status = installer.blenderBridgeInstallStatus(home)
  check('a tampered file breaks digestMatch', status.installed && !status.digestMatch)
  const text = await installer.describeBlenderBridgeStatus()
  check('add-on row: installed but out of date, the one sentence offers the refresh', /^add-on: installed, out of date — op:"blender_bridge_install" refreshes it$/m.test(text), text.split('\n').find(l => l.startsWith('add-on:')))
  installer.applyBlenderBridgeInstall()
  check('reinstall heals the drift', installer.blenderBridgeInstallStatus(home).digestMatch)
}

section('4. uninstall — the dir goes WHOLE (token and config ride along)')
{
  process.env.MERCURY_BLENDER_BRIDGE_PORT = '7999'
  installer.applyBlenderBridgeInstall()
  delete process.env.MERCURY_BLENDER_BRIDGE_PORT
  check('precondition: dir + token + config all exist', existsSync(dir) && existsSync(path.join(dir, 'token')) && existsSync(path.join(dir, 'config.json')))
  const receipt = installer.applyBlenderBridgeUninstall()
  check('receipt names the whole removal (add-on files, token, and any config.json)', /removed from .* \(add-on files, token, and any config\.json\)/.test(receipt))
  check('the directory is gone entirely', !existsSync(dir))
  check('the addon home itself survives (only OUR dir is removed)', existsSync(home))
  const again = installer.applyBlenderBridgeUninstall()
  check('a second uninstall answers honestly (was not installed)', /was not installed/.test(again))
}

section('5. the no-home refusal — nothing guessed, nothing written')
{
  resetEnv()
  process.env.MERCURY_BLENDER_BIN = path.join(scratch, 'no-such-blender')
  const receipt = installer.applyBlenderBridgeInstall()
  check('install refuses with the no-home reason', /no addon home to install into/.test(receipt))
  check('the refusal says nothing was written', /nothing was written/.test(receipt))
  const un = installer.applyBlenderBridgeUninstall()
  check('uninstall answers the same honesty', /no addon home resolved/.test(un))
  const status = await installer.describeBlenderBridgeStatus()
  check('status names the unresolved home and skips the probe', /addon home: UNRESOLVED/.test(status) && /not probed/.test(status))
  resetEnv()
  process.env.MERCURY_BLENDER_BIN = noBlender
  process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = home
}

section('6. status arms — flag, teaching, enablement honesty, reachability')
{
  resetEnv()
  process.env.MERCURY_BLENDER_BIN = noBlender
  process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = home
  const off = await installer.describeBlenderBridgeStatus()
  check('flag OFF named', /flag: OFF/.test(off))
  process.env.MERCURY_BLENDER = '1'
  const notInstalled = await installer.describeBlenderBridgeStatus()
  check('armed + not installed teaches the install op', /armed \(MERCURY_BLENDER\)/.test(notInstalled) && /NOT installed \(op:"blender_bridge_install"\)/.test(notInstalled))
  check('enablement is reported unknowable-from-disk with the probe as proof', /unknowable from disk/.test(notInstalled) && /ANSWERING bridge/.test(notInstalled))
  check('unreachable carries the teaching hint (install + enable + status)', /not answering/.test(notInstalled) && /blender_bridge_install/.test(notInstalled))
  check('a status read wrote nothing into the add-on home (no folder, no token)', !existsSync(dir) && readdirSync(home).length === 0, readdirSync(home).join(','))
  const again = await installer.describeBlenderBridgeStatus()
  check('a second status read still tells the token absent and names its writer', /^token file: absent \(blender_bridge_install writes it\)$/m.test(again), again.split('\n').find(l => l.startsWith('token file:')))
  check('no client is made while no token is on disk', getBlenderBridgeClient() === null && /^client: unavailable$/m.test(again))
  const wireRead = ((await BlenderTool.call({ op: 'scene_info' } as never, {} as never)) as { data: { result: string } }).data.result
  check('a wire read with no token on disk says so and names the install', /no session token on disk/.test(wireRead) && /blender_bridge_install/.test(wireRead), wireRead.slice(0, 160))
  check('the wire read wrote nothing either', !existsSync(dir) && readdirSync(home).length === 0, readdirSync(home).join(','))
  installer.applyBlenderBridgeInstall()
  check('the install, which asks, is what writes the token, and a client is made from it', existsSync(path.join(dir, 'token')) && getBlenderBridgeClient() !== null)
  resetBlenderBridgeClientForTest()
  const srv = await startFakeBlenderBridge()
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(srv.port)
  resetBlenderBridgeClientForTest()
  const reachable = await installer.describeBlenderBridgeStatus()
  check('a listening bridge reads as answering', new RegExp(`answering on 127\\.0\\.0\\.1:${srv.port}`).test(reachable))
  check('the config-vs-dialed mismatch row fires (config absent ⇒ add-on on the default, Mercury on the override)', /PORT MISMATCH/.test(reachable))
  await srv.close()
  resetBlenderBridgeClientForTest()
  resetEnv()
}

section('7. reinstall token rotation — singleton replaces the stale-token client')
{
  resetEnv()
  process.env.MERCURY_BLENDER = '1'
  process.env.MERCURY_BLENDER_BIN = noBlender
  process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = home
  resetBlenderBridgeClientForTest()
  installer.applyBlenderBridgeInstall()
  const tok1 = readFileSync(path.join(dir, 'token'), 'utf8').trim()
  const srv = await startFakeBlenderBridge({ token: tok1 })
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(srv.port)
  const c1 = getBlenderBridgeClient()
  await srv.close()
  installer.applyBlenderBridgeUninstall()
  installer.applyBlenderBridgeInstall()
  const tok2 = readFileSync(path.join(dir, 'token'), 'utf8').trim()
  const srv2 = await startFakeBlenderBridge({ token: tok2 })
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(srv2.port)
  await srv2.close()
  const srvSamePort = await startFakeBlenderBridge({ token: tok2 })
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(srvSamePort.port)
  resetBlenderBridgeClientForTest()
  writeFileSync(path.join(dir, 'token'), tok1 + '\n', { mode: 0o600 })
  const stale = getBlenderBridgeClient()!
  installer.applyBlenderBridgeUninstall()
  installer.applyBlenderBridgeInstall()
  const freshTok = readFileSync(path.join(dir, 'token'), 'utf8').trim()
  writeFileSync(path.join(dir, 'token'), tok2 + '\n', { mode: 0o600 })
  const rotated = getBlenderBridgeClient()!
  const authReply = await rotated.request('scene_info')
  await srvSamePort.close()
  check(
    'reinstall minting a new token on the same port replaces the client and authenticates without restart',
    c1 !== null && freshTok !== tok1 && tok2 !== tok1 && rotated !== stale && authReply.ok === true,
    authReply.ok ? 'ok' : `${authReply.error.code}: ${authReply.error.message}`,
  )
  resetBlenderBridgeClientForTest()
  resetEnv()
}

console.log('\n' + (failures === 0 ? '✅ blender-bridge install proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
