#!/usr/bin/env bun
// ============================================================================
//  scripts/unity-bridge/prove-unity-bridge-session.ts
//  PROOF: the fused Unity IDE session projection — the four bridge states
//  each naming their why, the arm surface on every disarmed string, editor
//  truth only through the client (with the boot-cwd scope guard), the
//  DURABLE tests door read by the LANDED parser end-to-end from a
//  bridge-triggered run, readiness rows armed-only — and the render-safety
//  TEETH: collecting readiness against a LISTENING fake makes ZERO
//  connections. Fake bridge + scratch trees only.
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

delete process.env.MERCURY_UNITY
delete process.env.MERCURY_UNITY_BRIDGE_PORT
delete process.env.MERCURY_UNITY_BRIDGE_TOKEN
process.env.MERCURY_UNITY_BRIDGE_TOKEN = 'tok' // the fake's default token

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { buildUnityBridgeIdeSession, unityBridgeReadinessRecords, UNITY_LANES_ARM_SURFACE } =
  await import('../../src/services/ide/unityBridgeSession.js')
const { resetUnityBridgeClientForTest, getUnityBridgeClient } = await import('../../src/services/unity/bridgeClient.js')
const installer = await import('../../src/services/unity/bridgeInstaller.js')
const { unityTestResultsPath } = await import('../../src/services/ide/unityProject.js')
const { startFakeUnityBridge } = await import('./fake-bridge.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'unity-bridge-session-'))
const proj = path.join(scratch, 'game')
mkdirSync(path.join(proj, 'Assets'), { recursive: true })
mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true })
const otherProj = path.join(scratch, 'other')
mkdirSync(path.join(otherProj, 'Assets'), { recursive: true })
mkdirSync(path.join(otherProj, 'ProjectSettings'), { recursive: true })
const bare = path.join(scratch, 'bare')
mkdirSync(bare, { recursive: true })

section('1. disarmed — a STATE naming the arm surface; readiness rows absent')
{
  const session = await runWithCwdOverride(proj, () => buildUnityBridgeIdeSession(proj))
  check('lane disarmed names the arm surface', session.unityLane.state === 'disarmed' && (session.unityLane as { armSurface: string }).armSurface === UNITY_LANES_ARM_SURFACE)
  check('bridge disarmed names the arm surface', session.bridge.state === 'disarmed' && session.bridge.detail.includes('Unity dev lanes'))
  check('editor truth unavailable with the why', session.editor.state === 'unavailable' && /bridge disarmed/.test((session.editor as { detail: string }).detail))
  check('project truth still collected (ungated, the landed doctrine)', session.project.state === 'ok')
  check('readiness rows are armed-only (off ⇒ none)', unityBridgeReadinessRecords().length === 0)
}

section('2. armed, no project — no-project state; readiness teaches activation')
{
  process.env.MERCURY_UNITY = '1'
  const session = await runWithCwdOverride(bare, () => buildUnityBridgeIdeSession(bare))
  check('bridge no-project state', session.bridge.state === 'no-project' && /Assets\/ \+ ProjectSettings\//.test(session.bridge.detail))
  check('project absent is a state, not an error', session.project.state === 'absent')
  const rows = await runWithCwdOverride(bare, async () => unityBridgeReadinessRecords())
  check('readiness: configured, activates-in-a-project sentence', rows.length === 1 && rows[0]!.state === 'configured' && /activates in a Unity project/.test(rows[0]!.detail))
}

section('3. armed, project, nothing listening — unreachable with teaching; readiness names the install remedy')
{
  const session = await runWithCwdOverride(proj, () => buildUnityBridgeIdeSession(proj))
  check('bridge unreachable with the install hint', session.bridge.state === 'unreachable' && /unity_bridge_install/.test(session.bridge.detail))
  check('install truth carried (not installed)', session.bridge.state === 'unreachable' && session.bridge.install.installed === false)
  check('editor truth unavailable (bridge unreachable)', session.editor.state === 'unavailable' && /unreachable/.test((session.editor as { detail: string }).detail))
  check('tests door: absent is a state with the operator road', /not found/.test(session.tests.editMode))
  const rows = await runWithCwdOverride(proj, async () => unityBridgeReadinessRecords())
  check('readiness: unavailable + the install remedy', rows.length === 1 && rows[0]!.state === 'unavailable' && /unity_bridge_install/.test(rows[0]!.remedy ?? ''))
}

section('4. readiness NEVER connects — the render-safety teeth')
{
  const fake = await startFakeUnityBridge()
  process.env.MERCURY_UNITY_BRIDGE_PORT = String(fake.port)
  installer.applyUnityBridgeInstall(proj)
  const rows = await runWithCwdOverride(proj, async () => unityBridgeReadinessRecords())
  check('readiness: configured with install truth', rows.length === 1 && rows[0]!.state === 'configured' && /matches the bundle/.test(rows[0]!.detail))
  check('readiness points at unity_status for the live probe', /unity_status/.test(rows[0]!.detail))
  check('ZERO connections were made by readiness (the law with teeth)', fake.connectionCount() === 0, `${fake.connectionCount()}`)
  await fake.close()
  delete process.env.MERCURY_UNITY_BRIDGE_PORT
}

section('5. reachable — editor truth through the client; the scope guard')
{
  resetUnityBridgeClientForTest()
  const fake = await startFakeUnityBridge()
  process.env.MERCURY_UNITY_BRIDGE_PORT = String(fake.port)
  const session = await runWithCwdOverride(proj, () => buildUnityBridgeIdeSession(proj))
  check('bridge reachable', session.bridge.state === 'reachable', session.bridge.state)
  check('editor truth ok: play state string', session.editor.state === 'ok' && /isPlaying/.test((session.editor as { playState: string }).playState))
  check('editor truth ok: scenes string', session.editor.state === 'ok' && /Assets\/Scenes\/Main\.unity/.test((session.editor as { scenes: string }).scenes))
  check('editor truth ok: console head string', session.editor.state === 'ok' && /entries/.test((session.editor as { consoleHead: string }).consoleHead))
  // The scope guard: a session built for ANOTHER project must not report
  // this editor's truth (the client is scoped to the boot-cwd project).
  const foreign = await runWithCwdOverride(proj, () => buildUnityBridgeIdeSession(otherProj))
  check('a foreign root answers the scope sentence, never the wrong editor', foreign.editor.state === 'unavailable' && /scoped to the working-directory project/.test((foreign.editor as { detail: string }).detail))
  await fake.close()
  delete process.env.MERCURY_UNITY_BRIDGE_PORT
}

section('6. the tests door end-to-end — bridge-triggered run, LANDED parser, projection counts')
{
  resetUnityBridgeClientForTest()
  const fake = await startFakeUnityBridge({ testRunDurationMs: 40 })
  process.env.MERCURY_UNITY_BRIDGE_PORT = String(fake.port)
  const resultsPath = unityTestResultsPath(proj, 'EditMode')
  await runWithCwdOverride(proj, async () => {
    const client = getUnityBridgeClient()
    check('the session client exists on the armed project path', client !== null)
    const started = await client!.request('tests_run', { mode: 'EditMode', resultsPath })
    check('tests_run started over the bridge', started.ok === true)
  })
  await sleep(120)
  const session = await runWithCwdOverride(proj, () => buildUnityBridgeIdeSession(proj))
  check('the projection reads the run through the LANDED door', /Passed: 3 passed · 0 failed/.test(session.tests.editMode), session.tests.editMode)
  check('the PlayMode door still answers absence honestly', /not found/.test(session.tests.playMode))
  await fake.close()
  delete process.env.MERCURY_UNITY_BRIDGE_PORT
  resetUnityBridgeClientForTest()
}

console.log('\n' + (failures === 0 ? '✅ unity-bridge session proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
