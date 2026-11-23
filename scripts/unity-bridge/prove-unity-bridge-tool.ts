#!/usr/bin/env bun

process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  const shown = !cond && hint ? (detail ? `${detail}; ${hint}` : hint) : detail
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

delete process.env.MERCURY_UNITY
delete process.env.MERCURY_UNITY_BRIDGE_PORT
process.env.MERCURY_UNITY_BRIDGE_TOKEN = 'tok'

const { runWithCwdOverride } = await import('../../src/platform/files/cwd.js')
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.js')
const { UnityTool } = await import('../../src/tools/unity/UnityTool.js')
const { getUnityToolDescription } = await import('../../src/tools/unity/prompt.js')
const { getUnityBridgeClient, resetUnityBridgeClientForTest } = await import('../../src/integrations/unity/bridgeClient.js')
const { unityBridgeTokenPath } = await import('../../src/integrations/unity/bridgeToken.js')
const { unityTestResultsPath } = await import('../../src/integrations/unity-protocol/unityProject.js')
const { computeHarnessMapLines } = await import('../../src/screen/cockpit-gauges/harnessMap.js')
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
  check('no Unity tool in the catalog even inside a project', runWithCwdOverride(proj, () => !hasUnity()), '', 'with MERCURY_UNITY unset, unityBridgeToolCatalogEnabled in src/integrations/unity-protocol/bridgeGates.ts must be false so getAllBaseTools in src/tools/kit/toolList.ts leaves UnityTool out')
  check('no client on any OFF path', runWithCwdOverride(proj, () => getUnityBridgeClient() === null), '', 'getUnityBridgeClient in src/integrations/unity/bridgeClient.ts must return null while the flag is off')
  check('NO token file was created by any OFF path', !existsSync(unityBridgeTokenPath(proj)), '', 'no OFF path may write the token file; see src/integrations/unity/bridgeToken.ts and its callers')
  check('no Unity harness-map line when OFF', !computeHarnessMapLines().some(l => l.includes('Unity lanes are armed')), '', 'computeHarnessMapLines in src/screen/cockpit-gauges/harnessMap.ts must add the Unity line only when the flag is on')
}

section('§2 · ARMED — catalog + teaching surfaces')
{
  process.env.MERCURY_UNITY = '1'
  resetUnityBridgeClientForTest()
  check('Unity tool present inside a project', runWithCwdOverride(proj, () => hasUnity()), '', 'with MERCURY_UNITY=1 and Assets/ plus ProjectSettings/ present, unityBridgeToolCatalogEnabled in src/integrations/unity-protocol/bridgeGates.ts must be true')
  check('Unity tool absent outside a project (no ghost tool)', runWithCwdOverride(scratch, () => !hasUnity()), '', 'unityBridgeToolCatalogEnabled in src/integrations/unity-protocol/bridgeGates.ts must require a Unity project at the cwd')
  const desc = getUnityToolDescription()
  check('description carries the verb catalog', desc.includes('tests_run') && desc.includes('hierarchy_read'), '', 'getUnityToolDescription in src/tools/unity/prompt.ts must list every verb')
  check('description says the reload fact once, in plain words: play mode drops the connection, the ack carries willReload, the next call reconnects', desc.split('reloads the editor\'s script domain and drops the bridge connection').length === 2 && desc.includes('willReload') && desc.includes('reconnects on the next call') && !desc.includes('RELOAD FACT'), '', 'fix the reload sentence in getUnityToolDescription (src/tools/unity/prompt.ts): it must appear exactly once and name willReload')
  check('description names no other tool and pre-empts no refusal', !/\b(LspRead|LspRename|Debug tool|Launch tool)\b/.test(desc) && !desc.includes('SCENE_DIRTY') && !desc.includes('teaching error'), '', 'remove the other tool names or refusal wording from getUnityToolDescription (src/tools/unity/prompt.ts)')
  check('description is under 1,800 bytes with the catalog', Buffer.byteLength(desc, 'utf8') <= 1800, `${Buffer.byteLength(desc, 'utf8')} bytes`, 'shorten getUnityToolDescription in src/tools/unity/prompt.ts')
  const unknown = await runWithCwdOverride(proj, () => callTool('scene_play'))
  check('unknown op teaches the verb list without reaching any wire', unknown.includes('unknown op') && unknown.includes('tests_run'), '', `the unknown-op reply in runOp in src/tools/unity/UnityTool.ts must list the verb names; got: ${unknown.slice(0, 200)}`)
  const status = await runWithCwdOverride(proj, () => callTool('unity_status'))
  check('unity_status answers locally: flag + package + reachability rows', /flag: armed/.test(status) && /NOT installed/.test(status) && /not answering/.test(status), '', `the unity_status text built in src/tools/unity/UnityTool.ts must carry the flag, package and reachability rows; got: ${status.slice(0, 300)}`)
  const harness = computeHarnessMapLines().find(l => l.includes('Unity lanes are armed'))
  check('the widened harness line names the Unity tool + the bridge install op', /`Unity` tool/.test(harness ?? '') && /unity_bridge_install/.test(harness ?? ''), '', 'edit the Unity line in computeHarnessMapLines in src/screen/cockpit-gauges/harnessMap.ts')
}

section('§3 · the permission ladder rides the contract classes')
{
  const perm = async (op: string, args?: Record<string, unknown>) =>
    (await UnityTool.checkPermissions!({ op, ...(args ? { args } : {}) } as never, {} as never)) as {
      behavior: string
      message?: string
    }
  for (const op of ['play_state', 'scene_list', 'hierarchy_read', 'console_tail']) {
    check(`read ⇒ allow: ${op}`, (await perm(op)).behavior === 'allow', '', 'checkPermissions in src/tools/unity/UnityTool.ts must allow read-class verbs')
  }
  const sceneOpen = await perm('scene_open', { path: 'Assets/S.unity' })
  check('scene_open ⇒ ask with the honest no-undo message', sceneOpen.behavior === 'ask' && /no undo step/.test(sceneOpen.message ?? '') && /SCENE_DIRTY/.test(sceneOpen.message ?? ''), '', `the final ask in checkPermissions (src/tools/unity/UnityTool.ts) must say no undo step and SCENE_DIRTY; got: ${JSON.stringify(sceneOpen)}`)
  for (const op of ['play_enter', 'play_exit', 'play_pause', 'tests_run']) {
    const p = await perm(op)
    check(`exec ⇒ ask ALWAYS: ${op}`, p.behavior === 'ask', '', 'the exec branch of checkPermissions in src/tools/unity/UnityTool.ts must ask')
  }
  const enter = await perm('play_enter')
  check('the play ask names the reload-reconnect fact', /domain reload/.test(enter.message ?? ''), '', `the exec ask text in checkPermissions (src/tools/unity/UnityTool.ts) must mention the domain reload; got: ${enter.message ?? ''}`)
  const tests = await perm('tests_run', { mode: 'EditMode' })
  check('the tests ask names the results door', /results door/.test(tests.message ?? ''), '', `the tests_run ask text in checkPermissions (src/tools/unity/UnityTool.ts) must mention the results door; got: ${tests.message ?? ''}`)
  const install = await perm('unity_bridge_install')
  check('unity_bridge_install ⇒ mutate ask naming its writes', install.behavior === 'ask' && /Packages\/com\.mercury\.unity-bridge/.test(install.message ?? ''), '', `the LOCAL_MUTATES ask in checkPermissions (src/tools/unity/UnityTool.ts) must name the package path; got: ${JSON.stringify(install)}`)
  const uninstall = await perm('unity_bridge_uninstall')
  check('unity_bridge_uninstall ⇒ mutate ask', uninstall.behavior === 'ask', '', 'unity_bridge_uninstall must be in LOCAL_MUTATES in src/tools/unity/UnityTool.ts')
  check('unknown ⇒ allow (the teaching path never reaches the editor)', (await perm('made_up')).behavior === 'allow', '', 'checkPermissions in src/tools/unity/UnityTool.ts must allow an op with no spec')
  check('isReadOnly mirrors the classes (+ unity_status)', UnityTool.isReadOnly!({ op: 'play_state' } as never) && UnityTool.isReadOnly!({ op: 'unity_status' } as never) && !UnityTool.isReadOnly!({ op: 'scene_open' } as never) && !UnityTool.isReadOnly!({ op: 'tests_run' } as never), '', 'isReadOnly in src/tools/unity/UnityTool.ts must be true only for read-class verbs and unity_status')
}

section('§4 · the wire path through the real tool, against the fake')
{
  resetUnityBridgeClientForTest()
  const fake = await startFakeUnityBridge({ willReloadOnPlay: false, testRunDurationMs: 40 })
  process.env.MERCURY_UNITY_BRIDGE_PORT = String(fake.port)
  const play = await runWithCwdOverride(proj, () => callTool('play_state'))
  check('play_state answers through the tool', play.includes('"isPlaying": false'), '', `callTool reaches the fake bridge through getUnityBridgeClient in src/integrations/unity/bridgeClient.ts; check the port and token handshake; got: ${play.slice(0, 200)}`)
  const enter = await runWithCwdOverride(proj, () => callTool('play_enter'))
  check('play_enter answers willReload', enter.includes('"willReload": false'), '', `runOp in src/tools/unity/UnityTool.ts must return the bridge ack unchanged; got: ${enter.slice(0, 200)}`)
  await sleep(50)
  const after = await runWithCwdOverride(proj, () => callTool('play_state'))
  const surfaced = [enter, after].filter(t => t.includes('events (') && t.includes('play_state_changed'))
  check('the play_state_changed event surfaces exactly once across the two calls', surfaced.length === 1, `${surfaced.length}`, 'the events block in src/tools/unity/UnityTool.ts must drain each bridge event once')
  const tests = await runWithCwdOverride(proj, () => callTool('tests_run', { mode: 'EditMode' }))
  const expectedPath = unityTestResultsPath(proj, 'EditMode')
  check('tests_run auto-fills the LANDED results path', tests.includes(expectedPath), '', `runOp in src/tools/unity/UnityTool.ts must fill resultsPath from unityTestResultsPath; expected ${expectedPath} in: ${tests.slice(0, 300)}`)
  await sleep(120)
  check('the run landed the XML at that path', existsSync(expectedPath), '', `the fake bridge in scripts/unity-bridge/fake-bridge.ts must write the XML to the resultsPath it was sent; missing: ${expectedPath}`)
  await fake.close()
  delete process.env.MERCURY_UNITY_BRIDGE_PORT
  resetUnityBridgeClientForTest()
  delete process.env.MERCURY_UNITY
}

console.log('\n' + (failures === 0 ? '✅ unity-bridge tool proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
