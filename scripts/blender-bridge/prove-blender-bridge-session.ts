#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
const SESSION_SRC = 'buildBlenderBridgeIdeSession in src/integrations/ide/blenderBridgeSession.ts'
const READY_SRC = 'blenderBridgeReadinessRecords in src/integrations/ide/blenderBridgeSession.ts'
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

const { runWithCwdOverride } = await import('../../src/platform/files/cwd.js')
const {
  buildBlenderBridgeIdeSession,
  blenderBridgeReadinessRecords,
  BLENDER_LANES_ARM_SURFACE,
} = await import('../../src/integrations/ide/blenderBridgeSession.js')
const { resetBlenderBridgeClientForTest } = await import('../../src/integrations/blender/bridgeClient.js')
const installer = await import('../../src/integrations/blender/bridgeInstaller.js')
const { readBlenderBridgeToken } = await import('../../src/integrations/blender/bridgeToken.js')
const { startFakeBlenderBridge } = await import('./fake-bridge.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-bridge-session-'))
const noBlender = path.join(scratch, 'no-such-blender')
process.env.MERCURY_BLENDER_BIN = noBlender
const home = path.join(scratch, 'addons')
mkdirSync(home, { recursive: true })
const work = path.join(scratch, 'studio')
mkdirSync(work, { recursive: true })

async function freshDeadPort(): Promise<number> {
  return new Promise<number>(resolve => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

section('1. disarmed — a STATE naming the arm surface; readiness rows absent')
{
  const session = await runWithCwdOverride(work, () => buildBlenderBridgeIdeSession(work))
  check(
    'lane disarmed names the arm surface',
    session.blenderLane.state === 'disarmed' &&
      (session.blenderLane as { armSurface: string }).armSurface === BLENDER_LANES_ARM_SURFACE,
    '',
    `${SESSION_SRC} should return blenderLane state disarmed with armSurface BLENDER_LANES_ARM_SURFACE while MERCURY_BLENDER is unset`,
  )
  check('bridge disarmed names the boot-menu row', session.bridge.state === 'disarmed' && session.bridge.detail.includes('Blender dev lanes'), '', `${SESSION_SRC} should report bridge state disarmed with a detail that names the Blender dev lanes boot-menu row`)
  check('editor truth unavailable with the why', session.editor.state === 'unavailable' && /bridge disarmed/.test((session.editor as { detail: string }).detail), '', `${SESSION_SRC} should report editor unavailable with a detail that says the bridge is disarmed`)
  check('context truth still collected (ungated, the landed doctrine)', session.context.state === 'ok', '', `${SESSION_SRC} should collect context truth even when the lane is disarmed`)
  check('readiness rows are armed-only (off ⇒ none)', blenderBridgeReadinessRecords().length === 0, '', `${READY_SRC} should return no rows while MERCURY_BLENDER is unset`)
}

section('2. armed, no home — the every-road reason; readiness names it')
{
  process.env.MERCURY_BLENDER = '1'
  process.env.MERCURY_BLENDER_BIN = path.join(scratch, 'no-such-blender')
  const session = await buildBlenderBridgeIdeSession(work)
  check('bridge no-home state carries the reason', session.bridge.state === 'no-home' && /MERCURY_BLENDER_BIN/.test(session.bridge.detail), '', `${SESSION_SRC} should report bridge state no-home with a detail that carries the reason naming MERCURY_BLENDER_BIN`)
  check('editor truth unavailable (no addon home)', session.editor.state === 'unavailable' && /no addon home/.test((session.editor as { detail: string }).detail), '', `${SESSION_SRC} should report editor unavailable with a detail saying there is no addon home`)
  const rows = blenderBridgeReadinessRecords()
  check('readiness: unavailable naming the reason + the pin roads', rows.length === 1 && rows[0]!.state === 'unavailable' && /MERCURY_BLENDER_BRIDGE_ADDON_DIR/.test(rows[0]!.remedy ?? ''), '', `${READY_SRC} should return one unavailable row whose remedy names MERCURY_BLENDER_BRIDGE_ADDON_DIR`)
  process.env.MERCURY_BLENDER_BIN = noBlender
}

section('3. armed, home, nothing listening — unreachable with teaching; readiness names the install remedy')
{
  process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = home
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(await freshDeadPort())
  resetBlenderBridgeClientForTest()
  const session = await buildBlenderBridgeIdeSession(work)
  check('bridge unreachable with the install + ENABLE hint', session.bridge.state === 'unreachable' && /blender_bridge_install/.test(session.bridge.detail) && /enable/i.test(session.bridge.detail), '', `${SESSION_SRC} should report bridge state unreachable with a detail naming blender_bridge_install and enabling the add-on`)
  check('install truth carried (not installed)', session.bridge.state === 'unreachable' && session.bridge.install.installed === false, '', `${SESSION_SRC} should carry install truth installed false on an unreachable bridge`)
  check('token truth carried (absent), and the read left the add-on home empty', session.bridge.state === 'unreachable' && session.bridge.tokenPresent === false && readdirSync(home).length === 0, readdirSync(home).join(','), `${SESSION_SRC} should carry tokenPresent false and must not write anything into the add-on home while reading`)
  check('editor truth unavailable (bridge unreachable)', session.editor.state === 'unavailable' && /unreachable/.test((session.editor as { detail: string }).detail), '', `${SESSION_SRC} should report editor unavailable with a detail saying the bridge is unreachable`)
  const rows = blenderBridgeReadinessRecords()
  check(
    'readiness: unavailable + the install remedy that keeps enabling the operator’s act',
    rows.length === 1 && rows[0]!.state === 'unavailable' && /blender_bridge_install/.test(rows[0]!.remedy ?? '') && /your act/.test(rows[0]!.remedy ?? ''),
    '',
    `${READY_SRC} should return one unavailable row whose remedy names blender_bridge_install and says enabling stays your act`,
  )
  delete process.env.MERCURY_BLENDER_BRIDGE_PORT
}

section('4. readiness NEVER connects — the render-safety teeth')
{
  installer.applyBlenderBridgeInstall()
  const token = readBlenderBridgeToken(home)!
  const fake = await startFakeBlenderBridge({ token })
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(fake.port)
  resetBlenderBridgeClientForTest()
  const rows = blenderBridgeReadinessRecords()
  check('readiness: configured with install truth', rows.length === 1 && rows[0]!.state === 'configured' && / \(up to date\)/.test(rows[0]!.detail), rows[0]?.detail.slice(0, 120), `${READY_SRC} should return one configured row whose detail ends with (up to date) from the install census`)
  check('readiness points at blender_status for the live probe', /blender_status/.test(rows[0]!.detail), '', `${READY_SRC} should point its detail at op blender_status for the live probe`)
  check('readiness reports enablement unknowable-from-disk', /unknowable from disk/.test(rows[0]!.detail), '', `${READY_SRC} should say in its detail that enablement is unknowable from disk`)
  check('ZERO connections were made by readiness (the law with teeth)', fake.connectionCount() === 0, `${fake.connectionCount()}`, `${READY_SRC} must read files only and never open a connection to the bridge port`)
  await fake.close()
  delete process.env.MERCURY_BLENDER_BRIDGE_PORT
}

section('5. reachable — editor truth through the client; the NO-scope-guard law')
{
  resetBlenderBridgeClientForTest()
  const token = readBlenderBridgeToken(home)!
  const fake = await startFakeBlenderBridge({ token })
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(fake.port)
  const session = await runWithCwdOverride(work, () => buildBlenderBridgeIdeSession(work))
  check('bridge reachable', session.bridge.state === 'reachable', session.bridge.state, `${SESSION_SRC} should report bridge state reachable when the fake bridge answers on MERCURY_BLENDER_BRIDGE_PORT with the installed token`)
  check('editor truth ok: scene info string', session.editor.state === 'ok' && /"engine":"BLENDER_EEVEE"/.test((session.editor as { sceneInfo: string }).sceneInfo), '', `${SESSION_SRC} should return editor state ok with sceneInfo carrying the engine from the bridge`)
  check('editor truth ok: render state string', session.editor.state === 'ok' && /"render":false/.test((session.editor as { renderState: string }).renderState) && /"engine":"BLENDER_EEVEE"/.test((session.editor as { renderState: string }).renderState), '', `${SESSION_SRC} should return editor state ok with renderState carrying render false and the engine`)
  check('editor truth ok: report head string', session.editor.state === 'ok' && /entries/.test((session.editor as { reportHead: string }).reportHead), '', `${SESSION_SRC} should return editor state ok with a reportHead string that mentions entries`)
  const elsewhere = path.join(scratch, 'elsewhere')
  mkdirSync(elsewhere, { recursive: true })
  const foreign = await runWithCwdOverride(elsewhere, () => buildBlenderBridgeIdeSession(elsewhere))
  check('a foreign cwd still answers editor truth (user-scoped bridge, by design)', foreign.editor.state === 'ok', '', `${SESSION_SRC} must not scope editor truth to the working directory, the bridge is user-scoped`)
  await fake.close()
  delete process.env.MERCURY_BLENDER_BRIDGE_PORT
  resetBlenderBridgeClientForTest()
}


resetEnv()
console.log('\n' + (failures === 0 ? '✅ blender-bridge session proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
