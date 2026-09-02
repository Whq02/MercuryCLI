#!/usr/bin/env bun
// ============================================================================
//  scripts/blender-bridge/prove-blender-bridge-session.ts
//  PROOF: the fused Blender IDE session — disarmed/no-home/unreachable/
//  reachable as STATES with teaching details, editor truth through the
//  existing client path, readiness rows that are armed-only and NEVER
//  connect (the render-safety teeth: connection count stays ZERO), the
//  deliberate NO-scope-guard difference (user-scoped bridge answers any
//  cwd), and the resource/readiness wiring pinned structurally. Fake-bridge
//  driven; no Blender.
// ============================================================================

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import * as net from 'node:net'
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

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const {
  buildBlenderBridgeIdeSession,
  blenderBridgeReadinessRecords,
  BLENDER_LANES_ARM_SURFACE,
} = await import('../../src/services/ide/blenderBridgeSession.js')
const { resetBlenderBridgeClientForTest } = await import('../../src/services/blender/bridgeClient.js')
const installer = await import('../../src/services/blender/bridgeInstaller.js')
const { readBlenderBridgeToken } = await import('../../src/services/blender/bridgeToken.js')
const { startFakeBlenderBridge } = await import('./fake-bridge.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-bridge-session-'))
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
  )
  check('bridge disarmed names the boot-menu row', session.bridge.state === 'disarmed' && session.bridge.detail.includes('Blender dev lanes'))
  check('editor truth unavailable with the why', session.editor.state === 'unavailable' && /bridge disarmed/.test((session.editor as { detail: string }).detail))
  check('context truth still collected (ungated, the landed doctrine)', session.context.state === 'ok')
  check('readiness rows are armed-only (off ⇒ none)', blenderBridgeReadinessRecords().length === 0)
}

section('2. armed, no home — the every-road reason; readiness names it')
{
  process.env.MERCURY_BLENDER = '1'
  process.env.MERCURY_BLENDER_BIN = path.join(scratch, 'no-such-blender')
  const session = await buildBlenderBridgeIdeSession(work)
  check('bridge no-home state carries the reason', session.bridge.state === 'no-home' && /MERCURY_BLENDER_BIN/.test(session.bridge.detail))
  check('editor truth unavailable (no addon home)', session.editor.state === 'unavailable' && /no addon home/.test((session.editor as { detail: string }).detail))
  const rows = blenderBridgeReadinessRecords()
  check('readiness: unavailable naming the reason + the pin roads', rows.length === 1 && rows[0]!.state === 'unavailable' && /MERCURY_BLENDER_BRIDGE_ADDON_DIR/.test(rows[0]!.remedy ?? ''))
  delete process.env.MERCURY_BLENDER_BIN
}

section('3. armed, home, nothing listening — unreachable with teaching; readiness names the install remedy')
{
  process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = home
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(await freshDeadPort())
  resetBlenderBridgeClientForTest()
  const session = await buildBlenderBridgeIdeSession(work)
  check('bridge unreachable with the install + ENABLE hint', session.bridge.state === 'unreachable' && /blender_bridge_install/.test(session.bridge.detail) && /enable/i.test(session.bridge.detail))
  check('install truth carried (not installed)', session.bridge.state === 'unreachable' && session.bridge.install.installed === false)
  check('editor truth unavailable (bridge unreachable)', session.editor.state === 'unavailable' && /unreachable/.test((session.editor as { detail: string }).detail))
  const rows = blenderBridgeReadinessRecords()
  check(
    'readiness: unavailable + the install remedy that keeps enabling the operator’s act',
    rows.length === 1 && rows[0]!.state === 'unavailable' && /blender_bridge_install/.test(rows[0]!.remedy ?? '') && /your act/.test(rows[0]!.remedy ?? ''),
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
  check('readiness: configured with install truth', rows.length === 1 && rows[0]!.state === 'configured' && /matches the bundle/.test(rows[0]!.detail))
  check('readiness points at blender_status for the live probe', /blender_status/.test(rows[0]!.detail))
  check('readiness reports enablement unknowable-from-disk', /unknowable from disk/.test(rows[0]!.detail))
  check('ZERO connections were made by readiness (the law with teeth)', fake.connectionCount() === 0, `${fake.connectionCount()}`)
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
  check('bridge reachable', session.bridge.state === 'reachable', session.bridge.state)
  check('editor truth ok: scene info string', session.editor.state === 'ok' && /BLENDER_EEVEE_NEXT/.test((session.editor as { sceneInfo: string }).sceneInfo))
  check('editor truth ok: render state string', session.editor.state === 'ok' && /"render":false/.test((session.editor as { renderState: string }).renderState))
  check('editor truth ok: report head string', session.editor.state === 'ok' && /entries/.test((session.editor as { reportHead: string }).reportHead))
  // THE NO-SCOPE-GUARD PIN (the recorded inverse of the unity sibling): the
  // bridge is user-scoped — a session built for ANY OTHER cwd still reads
  // the one user bridge's truth.
  const elsewhere = path.join(scratch, 'elsewhere')
  mkdirSync(elsewhere, { recursive: true })
  const foreign = await runWithCwdOverride(elsewhere, () => buildBlenderBridgeIdeSession(elsewhere))
  check('a foreign cwd still answers editor truth (user-scoped bridge, by design)', foreign.editor.state === 'ok')
  await fake.close()
  delete process.env.MERCURY_BLENDER_BRIDGE_PORT
  resetBlenderBridgeClientForTest()
}

section('6. the wiring — resource row + readiness push, pinned structurally')
{
  const repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
  const ide = readFileSync(path.join(repo, 'src', 'services', 'resources', 'adapters', 'ide.ts'), 'utf8')
  check('the roster carries mercury://ide/blender/session', ide.includes("ref: 'mercury://ide/blender/session'"))
  check('the fetch branch builds the session', ide.includes("ref.id === 'blender/session'") && ide.includes('buildBlenderBridgeIdeSession(ctx.cwd)'))
  const readiness = readFileSync(path.join(repo, 'src', 'utils', 'readiness.ts'), 'utf8')
  check('readiness pushes the bridge rows beside the lane rows', readiness.includes('blenderBridgeReadinessRecords()'))
}

resetEnv()
console.log('\n' + (failures === 0 ? '✅ blender-bridge session proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
