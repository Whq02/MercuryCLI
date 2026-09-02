#!/usr/bin/env bun
// ============================================================================
//  scripts/unity-bridge/prove-unity-bridge-tool.ts
//  PROOF: the Unity tool's catalog gating (the one-switch law: OFF is
//  byte-identical absence — no tool, no client, no token file, no harness
//  line), the permission ladder riding the contract classes (read ⇒ allow ·
//  scene_open's honest no-undo message · exec ask-always · install/uninstall
//  mutate asks), the teaching answers (unknown op, absent bridge), the wire
//  path through the REAL tool against the fake (events surfaced; tests_run
//  auto-filling the LANDED results path), and the widened harness-map line.
// ============================================================================

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
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
process.env.MERCURY_UNITY_BRIDGE_TOKEN = 'tok' // the fake's default token

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { getAllBaseTools } = await import('../../src/tools.js')
const { UnityTool } = await import('../../src/tools/UnityTool/UnityTool.js')
const { getUnityToolDescription } = await import('../../src/tools/UnityTool/prompt.js')
const { getUnityBridgeClient, resetUnityBridgeClientForTest } = await import('../../src/services/unity/bridgeClient.js')
const { unityBridgeTokenPath } = await import('../../src/services/unity/bridgeToken.js')
const { unityTestResultsPath } = await import('../../src/services/ide/unityProject.js')
const { computeHarnessMapLines } = await import('../../src/utils/cockpit/harnessMap.js')
const { startFakeUnityBridge } = await import('./fake-bridge.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'unity-bridge-tool-'))
const proj = path.join(scratch, 'game')
mkdirSync(path.join(proj, 'Assets'), { recursive: true })
mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true })

const hasUnity = () => getAllBaseTools().some(t => t.name === 'Unity')
const callTool = async (op: string, args?: Record<string, unknown>): Promise<string> => {
  const r = (await UnityTool.call({ op, ...(args ? { args } : {}) } as never, {} as never)) as {
    data: { result: string }
  }
  return r.data.result
}

section('§1 · OFF (default) — byte-identical absence')
{
  resetUnityBridgeClientForTest()
  check('no Unity tool in the catalog even inside a project', runWithCwdOverride(proj, () => !hasUnity()))
  check('no client on any OFF path', runWithCwdOverride(proj, () => getUnityBridgeClient() === null))
  check('NO token file was created by any OFF path', !existsSync(unityBridgeTokenPath(proj)))
  check('no Unity harness-map line when OFF', !computeHarnessMapLines().some(l => l.includes('Unity lanes are ARMED')))
}

section('§2 · ARMED — catalog + teaching surfaces')
{
  process.env.MERCURY_UNITY = '1'
  resetUnityBridgeClientForTest()
  check('Unity tool present inside a project', runWithCwdOverride(proj, () => hasUnity()))
  check('Unity tool absent outside a project (no ghost tool)', runWithCwdOverride(scratch, () => !hasUnity()))
  const desc = getUnityToolDescription()
  check('description carries the verb catalog', desc.includes('tests_run') && desc.includes('hierarchy_read'))
  check('description teaches THE RELOAD FACT', desc.includes('RELOAD FACT') && desc.includes('willReload'))
  check('description routes symbols/breakpoints/headless elsewhere', desc.includes('LSP tool') && desc.includes('Debug tool') && desc.includes('Launch tool'))
  const unknown = await runWithCwdOverride(proj, () => callTool('scene_play'))
  check('unknown op teaches the verb list without reaching any wire', unknown.includes('unknown op') && unknown.includes('tests_run'))
  const status = await runWithCwdOverride(proj, () => callTool('unity_status'))
  check('unity_status answers locally: flag + package + reachability rows', /flag: armed/.test(status) && /NOT installed/.test(status) && /not answering/.test(status))
  const harness = computeHarnessMapLines().find(l => l.includes('Unity lanes are ARMED'))
  check('the widened harness line names the Unity tool + the bridge install op', /`Unity` tool/.test(harness ?? '') && /unity_bridge_install/.test(harness ?? ''))
}

section('§3 · the permission ladder rides the contract classes')
{
  const perm = async (op: string, args?: Record<string, unknown>) =>
    (await UnityTool.checkPermissions!({ op, ...(args ? { args } : {}) } as never, {} as never)) as {
      behavior: string
      message?: string
    }
  for (const op of ['play_state', 'scene_list', 'hierarchy_read', 'console_tail']) {
    check(`read ⇒ allow: ${op}`, (await perm(op)).behavior === 'allow')
  }
  const sceneOpen = await perm('scene_open', { path: 'Assets/S.unity' })
  check('scene_open ⇒ ask with the honest no-undo message', sceneOpen.behavior === 'ask' && /no undo step/.test(sceneOpen.message ?? '') && /SCENE_DIRTY/.test(sceneOpen.message ?? ''))
  for (const op of ['play_enter', 'play_exit', 'play_pause', 'tests_run']) {
    const p = await perm(op)
    check(`exec ⇒ ask ALWAYS: ${op}`, p.behavior === 'ask')
  }
  const enter = await perm('play_enter')
  check('the play ask names the reload-reconnect fact', /domain reload/.test(enter.message ?? ''))
  const tests = await perm('tests_run', { mode: 'EditMode' })
  check('the tests ask names the results door', /results door/.test(tests.message ?? ''))
  const install = await perm('unity_bridge_install')
  check('unity_bridge_install ⇒ mutate ask naming its writes', install.behavior === 'ask' && /Packages\/com\.mercury\.unity-bridge/.test(install.message ?? ''))
  const uninstall = await perm('unity_bridge_uninstall')
  check('unity_bridge_uninstall ⇒ mutate ask', uninstall.behavior === 'ask')
  check('unknown ⇒ allow (the teaching path never reaches the editor)', (await perm('made_up')).behavior === 'allow')
  check('isReadOnly mirrors the classes (+ unity_status)', UnityTool.isReadOnly!({ op: 'play_state' } as never) && UnityTool.isReadOnly!({ op: 'unity_status' } as never) && !UnityTool.isReadOnly!({ op: 'scene_open' } as never) && !UnityTool.isReadOnly!({ op: 'tests_run' } as never))
}

section('§4 · the wire path through the real tool, against the fake')
{
  resetUnityBridgeClientForTest()
  const fake = await startFakeUnityBridge({ willReloadOnPlay: false, testRunDurationMs: 40 })
  process.env.MERCURY_UNITY_BRIDGE_PORT = String(fake.port)
  const play = await runWithCwdOverride(proj, () => callTool('play_state'))
  check('play_state answers through the tool', play.includes('"isPlaying": false'))
  const enter = await runWithCwdOverride(proj, () => callTool('play_enter'))
  check('play_enter answers willReload', enter.includes('"willReload": false'))
  await sleep(50)
  const after = await runWithCwdOverride(proj, () => callTool('play_state'))
  // The event frame rides the same connection right behind the response —
  // whichever call's drain catches it, it must surface exactly once.
  const surfaced = [enter, after].filter(t => t.includes('events (') && t.includes('play_state_changed'))
  check('the play_state_changed event surfaces exactly once across the two calls', surfaced.length === 1, `${surfaced.length}`)
  const tests = await runWithCwdOverride(proj, () => callTool('tests_run', { mode: 'EditMode' }))
  const expectedPath = unityTestResultsPath(proj, 'EditMode')
  check('tests_run auto-fills the LANDED results path', tests.includes(expectedPath))
  await sleep(120)
  check('the run landed the XML at that path', existsSync(expectedPath))
  await fake.close()
  delete process.env.MERCURY_UNITY_BRIDGE_PORT
  resetUnityBridgeClientForTest()
  delete process.env.MERCURY_UNITY
}

console.log('\n' + (failures === 0 ? '✅ unity-bridge tool proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
