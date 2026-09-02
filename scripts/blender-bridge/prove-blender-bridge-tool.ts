#!/usr/bin/env bun
// ============================================================================
//  scripts/blender-bridge/prove-blender-bridge-tool.ts
//  PROOF: the Blender tool's catalog gating (the one-switch law: OFF is
//  byte-identical absence — no tool, no client, no token file, no harness
//  line), the permission ladder riding the contract classes (read ⇒ allow ·
//  blend_open's honest no-undo message · exec ask-always with python_run's
//  byte-count + first-line wording · install/uninstall mutate asks), the
//  DANGER SENTENCES verbatim in the tool description (the double-pin's
//  second half — the contract prover pins the constants, THIS pins the
//  surface), the Mercury-side path fence (never reaches the wire), the
//  teaching answers, the wire path through the REAL tool against the fake
//  (render road with the durable file + the event surfacing exactly once;
//  python_run shapes), and the widened harness-map line.
// ============================================================================

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
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

for (const k of [
  'MERCURY_BLENDER',
  'MERCURY_BLENDER_BIN',
  'MERCURY_BLENDER_BRIDGE_PORT',
  'MERCURY_BLENDER_BRIDGE_ADDON_DIR',
  'BLENDER_USER_SCRIPTS',
  'BLENDER_USER_RESOURCES',
]) {
  delete process.env[k]
}
process.env.MERCURY_BLENDER_BRIDGE_TOKEN = 'tok' // the fake's default token

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { getAllBaseTools } = await import('../../src/tools.js')
const { BlenderTool } = await import('../../src/tools/BlenderTool/BlenderTool.js')
const { getBlenderToolDescription } = await import('../../src/tools/BlenderTool/prompt.js')
const {
  BLENDER_PYTHON_RUN_NO_SANDBOX_SENTENCE,
  BLENDER_PYTHON_RUN_NO_PREEMPTION_SENTENCE,
} = await import('../../src/services/blender/bridgeProtocol.js')
const { getBlenderBridgeClient, resetBlenderBridgeClientForTest } = await import('../../src/services/blender/bridgeClient.js')
const { _resetBlenderBridgeContextCacheForTesting } = await import('../../src/utils/blender/bridgeGates.js')
const { computeHarnessMapLines } = await import('../../src/utils/cockpit/harnessMap.js')
const { startFakeBlenderBridge } = await import('./fake-bridge.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-bridge-tool-'))
const work = path.join(scratch, 'studio')
mkdirSync(work, { recursive: true })
writeFileSync(path.join(work, 'scene.blend'), 'BLENDER-fake')
const bare = path.join(scratch, 'bare')
mkdirSync(bare, { recursive: true })
const addonHome = path.join(scratch, 'addons')
mkdirSync(addonHome, { recursive: true })

const hasBlender = () => getAllBaseTools().some(t => t.name === 'Blender')
const callTool = async (op: string, args?: Record<string, unknown>): Promise<string> => {
  const r = (await BlenderTool.call({ op, ...(args ? { args } : {}) } as never, {} as never)) as {
    data: { result: string }
  }
  return r.data.result
}

section('§1 · OFF (default) — byte-identical absence')
{
  resetBlenderBridgeClientForTest()
  _resetBlenderBridgeContextCacheForTesting()
  process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = addonHome
  check('no Blender tool in the catalog even beside a .blend', await runWithCwdOverride(work, async () => !hasBlender()))
  check('no client on any OFF path', getBlenderBridgeClient() === null)
  check('the pinned addon home stayed EMPTY (no token, no dir, nothing)', readdirSync(addonHome).length === 0)
  check('no Blender harness-map line when OFF', !computeHarnessMapLines().some(l => l.includes('Blender lanes are ARMED')))
}

section('§2 · ARMED — catalog + teaching surfaces + the danger sentences (the double-pin)')
{
  process.env.MERCURY_BLENDER = '1'
  resetBlenderBridgeClientForTest()
  _resetBlenderBridgeContextCacheForTesting()
  check('Blender tool present beside a .blend', await runWithCwdOverride(work, async () => hasBlender()))
  _resetBlenderBridgeContextCacheForTesting()
  check('Blender tool absent in a blend-less dir (no ghost tool)', await runWithCwdOverride(bare, async () => !hasBlender()))
  const desc = getBlenderToolDescription()
  check('description carries the verb catalog', desc.includes('python_run') && desc.includes('objects_list') && desc.includes('blender_bridge_install'))
  check('description teaches THE NO-RELOAD FACT', desc.includes('NO-RELOAD FACT') && desc.includes('connection HOLDS'))
  check('description carries the NO-SANDBOX danger sentence VERBATIM', desc.includes(BLENDER_PYTHON_RUN_NO_SANDBOX_SENTENCE))
  check('description carries the NO-PREEMPTION danger sentence VERBATIM', desc.includes(BLENDER_PYTHON_RUN_NO_PREEMPTION_SENTENCE))
  check('description names the enable act as the operator’s', /ENABLING IT IN BLENDER STAYS YOUR ACT/.test(desc))
  check('description routes breakpoints/headless elsewhere', desc.includes('Debug tool') && desc.includes('Launch tool'))
  const unknown = await runWithCwdOverride(work, () => callTool('tests_run'))
  check('unknown op teaches the verb list without reaching any wire', unknown.includes('unknown op') && unknown.includes('python_run'))
  const status = await runWithCwdOverride(work, () => callTool('blender_status'))
  check('blender_status answers locally: flag + home + install + reachability rows', /flag: armed/.test(status) && /addon home/.test(status) && /NOT installed/.test(status))
  const harness = computeHarnessMapLines().find(l => l.includes('Blender lanes are ARMED'))
  check('the widened harness line names the Blender tool + install op + the enable act', /`Blender` tool/.test(harness ?? '') && /blender_bridge_install/.test(harness ?? '') && /your act/.test(harness ?? ''))
}

section('§3 · the permission ladder rides the contract classes')
{
  const perm = async (op: string, args?: Record<string, unknown>) =>
    (await BlenderTool.checkPermissions!({ op, ...(args ? { args } : {}) } as never, {} as never)) as {
      behavior: string
      message?: string
    }
  for (const op of ['scene_info', 'objects_list', 'render_state', 'report_tail']) {
    check(`read ⇒ allow: ${op}`, (await perm(op)).behavior === 'allow')
  }
  const open = await perm('blend_open', { path: 'scene.blend' })
  check('blend_open ⇒ ask with the honest no-undo message', open.behavior === 'ask' && /no undo step/.test(open.message ?? '') && /BLEND_DIRTY/.test(open.message ?? ''))
  const py = await perm('python_run', { source: 'import bpy\nbpy.ops.mesh.primitive_cube_add()' })
  check('python_run ⇒ ask ALWAYS carrying byte count + first line', py.behavior === 'ask' && /\d+ bytes/.test(py.message ?? '') && /first line: import bpy/.test(py.message ?? ''))
  check('the python_run ask names full bpy authority + no preemption', /full bpy authority/.test(py.message ?? '') && /no preemption/.test(py.message ?? ''))
  const still = await perm('render_still', { outputPath: '/tmp/x.png' })
  check('render_still ⇒ ask naming the durable file', still.behavior === 'ask' && /durable result/.test(still.message ?? ''))
  const install = await perm('blender_bridge_install')
  check('blender_bridge_install ⇒ mutate ask naming its writes + the enable act', install.behavior === 'ask' && /user addon home/.test(install.message ?? '') && /your act/.test(install.message ?? ''))
  const uninstall = await perm('blender_bridge_uninstall')
  check('blender_bridge_uninstall ⇒ mutate ask naming WHOLE removal', uninstall.behavior === 'ask' && /WHOLE/.test(uninstall.message ?? ''))
  check('unknown ⇒ allow (the teaching path never reaches Blender)', (await perm('made_up')).behavior === 'allow')
  check(
    'isReadOnly mirrors the classes (+ blender_status)',
    BlenderTool.isReadOnly!({ op: 'scene_info' } as never) &&
      BlenderTool.isReadOnly!({ op: 'blender_status' } as never) &&
      !BlenderTool.isReadOnly!({ op: 'blend_open' } as never) &&
      !BlenderTool.isReadOnly!({ op: 'python_run' } as never),
  )
  const classifier = BlenderTool.toAutoClassifierInput!({ op: 'python_run', args: { source: 'x'.repeat(400) } } as never)
  check('the classifier sees the python_run head (300 chars)', typeof classifier === 'string' && classifier.includes('blender exec: python_run') && classifier.length < 350)
}

section('§4 · the Mercury-side path fence — never reaches the wire')
{
  resetBlenderBridgeClientForTest()
  const fake = await startFakeBlenderBridge()
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(fake.port)
  const outside = await runWithCwdOverride(work, () => callTool('blend_open', { path: '../outside.blend' }))
  check('an escaping path refuses with the fence teaching', /must stay inside the working tree/.test(outside))
  check('the fence fired BEFORE the wire (the fake saw no blend_open)', !fake.seenOps.includes('blend_open'), fake.seenOps.join(','))
  const outAbs = await runWithCwdOverride(work, () => callTool('render_still', { outputPath: '/etc/render.png' }))
  check('an absolute outside outputPath refuses the same way', /must stay inside the working tree/.test(outAbs))
  // THE SYMLINK ARM (realpath both sides — the house law): a link INSIDE
  // the tree pointing OUTSIDE must not smuggle a path past the fence.
  const outsideDir = path.join(scratch, 'smuggle')
  mkdirSync(outsideDir, { recursive: true })
  symlinkSync(outsideDir, path.join(work, 'link-out'))
  const viaLink = await runWithCwdOverride(work, () => callTool('render_still', { outputPath: path.join('link-out', 'x.png') }))
  check('a symlink escape refuses (the lexical spelling was inside; the real path is not)', /must stay inside the working tree/.test(viaLink))
  check('the symlink escape never reached the wire either', !fake.seenOps.includes('render_still'), fake.seenOps.join(','))
  await fake.close()
  delete process.env.MERCURY_BLENDER_BRIDGE_PORT
}

section('§5 · the wire path through the real tool, against the fake')
{
  resetBlenderBridgeClientForTest()
  const fake = await startFakeBlenderBridge({ renderDurationMs: 60 })
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(fake.port)
  const info = await runWithCwdOverride(work, () => callTool('scene_info'))
  check('scene_info answers through the tool', info.includes('"engine": "BLENDER_EEVEE_NEXT"'))
  // The fence realpaths (symlink law), so the ack carries the REAL spelling
  // — on macOS tmpdir that differs lexically (/var → /private/var).
  const outputPath = path.join(realpathSync(work), 'renders', 'frame.png')
  const still = await runWithCwdOverride(work, () => callTool('render_still', { outputPath: path.join('renders', 'frame.png'), frame: 1 }))
  check('render_still acks started with the RESOLVED (real) outputPath', still.includes('"started": true') && still.includes(outputPath))
  await sleep(120)
  const after = await runWithCwdOverride(work, () => callTool('render_state'))
  check('the durable file landed at the fenced path', existsSync(outputPath))
  // The event frame rides the connection right behind completion — whichever
  // call's drain catches it, it must surface exactly once.
  const surfaced = [still, after].filter(t => t.includes('events (') && t.includes('render_finished'))
  check('the render_finished event surfaces exactly once across the two calls', surfaced.length === 1, `${surfaced.length}`)
  const py = await runWithCwdOverride(work, () => callTool('python_run', { source: 'result = 40 + 2' }))
  check('python_run answers the value shape through the tool', py.includes(`"value": "'fixture-value'"`))
  const boom = await runWithCwdOverride(work, () => callTool('python_run', { source: 'raise ValueError("BOOM")' }))
  check('a raising python_run answers PYTHON_EXCEPTION with the tail hint', boom.includes('[PYTHON_EXCEPTION]') && boom.includes('traceback (tail)'))
  await fake.close()
  delete process.env.MERCURY_BLENDER_BRIDGE_PORT
  resetBlenderBridgeClientForTest()
  delete process.env.MERCURY_BLENDER
}

console.log('\n' + (failures === 0 ? '✅ blender-bridge tool proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
