#!/usr/bin/env bun

process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
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
process.env.MERCURY_BLENDER_BRIDGE_TOKEN = 'tok'

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
const { formatDeferredToolLine } = await import('../../src/tools/ToolSearchTool/prompt.js')
const { searchToolsWithKeywords, clearToolSearchDescriptionCache } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.js')
const { startFakeBlenderBridge } = await import('./fake-bridge.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-bridge-tool-'))
const work = path.join(scratch, 'studio')
mkdirSync(work, { recursive: true })
writeFileSync(path.join(work, 'scene.blend'), 'BLENDER-fake')
const bare = path.join(scratch, 'bare')
mkdirSync(bare, { recursive: true })
const addonHome = path.join(scratch, 'addons')
mkdirSync(addonHome, { recursive: true })
const noBlender = path.join(scratch, 'no-such-blender')
const pinnedBlender = path.join(scratch, 'pinned-blender')
writeFileSync(pinnedBlender, '#!/bin/sh\n')

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
  check('no Blender harness-map line when OFF', !computeHarnessMapLines().some(l => l.includes('Blender lanes are armed')))
}

section('§2 · ARMED — catalog + teaching surfaces + the danger sentences (the double-pin)')
{
  process.env.MERCURY_BLENDER = '1'
  process.env.MERCURY_BLENDER_BIN = noBlender
  resetBlenderBridgeClientForTest()
  _resetBlenderBridgeContextCacheForTesting()
  check('Blender tool present beside a .blend', await runWithCwdOverride(work, async () => hasBlender()))
  _resetBlenderBridgeContextCacheForTesting()
  check('Blender tool absent in a blend-less dir with no Blender located (no ghost tool)', await runWithCwdOverride(bare, async () => !hasBlender()))
  process.env.MERCURY_BLENDER_BIN = pinnedBlender
  _resetBlenderBridgeContextCacheForTesting()
  check('Blender tool present in a blend-less dir once a Blender is located', await runWithCwdOverride(bare, async () => hasBlender()))
  process.env.MERCURY_BLENDER_BIN = noBlender
  _resetBlenderBridgeContextCacheForTesting()
  const rosterLine = formatDeferredToolLine(BlenderTool as never)
  check(
    'the roster line is shown whole and says the road with no window in its first words',
    !rosterLine.endsWith('…') && rosterLine.startsWith('Blender — Blender with no window'),
    rosterLine,
  )
  check(
    'the roster line names a running Blender too, and the three things a session looks for',
    rosterLine.includes('a running one') &&
      rosterLine.includes('run Python or a script') &&
      rosterLine.includes('render a still') &&
      rosterLine.includes('read the scene'),
    rosterLine,
  )
  check('the roster line no longer reads as the bridge alone', !rosterLine.includes('the Mercury bridge'), rosterLine)
  const oneLine = await BlenderTool.description({} as never, {} as never)
  check(
    'the one-line description says both roads: the background with no window when no bridge answers, a running Blender when one does',
    oneLine.includes('in the background with no window when no bridge answers') &&
      oneLine.includes('a running Blender when one does') &&
      !oneLine.startsWith('Drive the running Blender'),
    oneLine,
  )
  clearToolSearchDescriptionCache()
  check(
    'a search for headless or for background finds the tool by its search words',
    (await searchToolsWithKeywords('+headless', [BlenderTool as never], [BlenderTool as never], 5)).includes('Blender') &&
      (await searchToolsWithKeywords('+background', [BlenderTool as never], [BlenderTool as never], 5)).includes('Blender') &&
      (BlenderTool.searchKeywords ?? []).includes('headless') &&
      (BlenderTool.searchKeywords ?? []).includes('background'),
    JSON.stringify(BlenderTool.searchKeywords ?? null),
  )
  const desc = getBlenderToolDescription()
  check('description carries the verb catalog', desc.includes('python_run') && desc.includes('objects_list') && desc.includes('blender_bridge_install'))
  check('description says once that the connection holds across opens and renders', desc.split('The connection holds across blend_open and renders.').length === 2 && !desc.includes('NO-RELOAD'))
  check('description carries the NO-SANDBOX danger sentence VERBATIM, once', desc.split(BLENDER_PYTHON_RUN_NO_SANDBOX_SENTENCE).length === 2)
  check('description carries the NO-PREEMPTION danger sentence VERBATIM, once', desc.split(BLENDER_PYTHON_RUN_NO_PREEMPTION_SENTENCE).length === 2)
  check('description names the enable act as the operator’s', /enabling it in Blender is the operator's act/.test(desc))
  check('description names no other tool and pre-empts no refusal', !/\b(Debug|Launch|Unity) tool\b/.test(desc) && !desc.includes('RENDER_ACTIVE') && !desc.includes('BLEND_DIRTY') && !desc.includes('teaching error'))
  check(
    'description teaches the stateless one-process-per-call headless road and naming blend on the next call',
    desc.includes('no state is kept') &&
      desc.includes('name blend on the next call') &&
      desc.includes('closed with the process'),
    desc.slice(0, 260),
  )
  check('description is under 2,400 bytes with the catalog', Buffer.byteLength(desc, 'utf8') <= 2400, `${Buffer.byteLength(desc, 'utf8')} bytes`)
  const unknown = await runWithCwdOverride(work, () => callTool('tests_run'))
  check('unknown op teaches the verb list without reaching any wire', unknown.includes('unknown op') && unknown.includes('python_run'))
  const status = await runWithCwdOverride(work, () => callTool('blender_status'))
  check('blender_status answers locally: flag + home + install + reachability rows', /flag: armed/.test(status) && /addon home/.test(status) && /NOT installed/.test(status))
  const harness = computeHarnessMapLines().find(l => l.includes('Blender lanes are armed'))
  check('the widened harness line names the Blender tool + install op + the enable act', /`Blender` tool/.test(harness ?? '') && /blender_bridge_install/.test(harness ?? '') && /your act/.test(harness ?? ''))
  const locatorSentence =
    'The tool joins the catalog beside .blend files or wherever Blender is located (PATH, the Blender.app in /Applications or ~/Applications, Program Files); a Blender installed anywhere else is named with MERCURY_BLENDER_BIN=<its binary>.'
  check('harness line carries the locator sentence while nothing is located', (harness ?? '').includes(locatorSentence), harness ?? '')
  process.env.MERCURY_BLENDER_BIN = pinnedBlender
  const harnessLocated = computeHarnessMapLines().find(l => l.includes('Blender lanes are armed'))
  check('harness line omits the locator sentence once a Blender is located', !(harnessLocated ?? '').includes(locatorSentence))
  const policySentence =
    'Mercury never installs or enables Blender, and starts it only with no window, when the Blender tool is called.'
  check(
    'harness line carries the policy sentence both when nothing is located and when located',
    (harness ?? '').includes(policySentence) &&
      (harnessLocated ?? '').includes(policySentence) &&
      !(harness ?? '').includes('Nothing is installed or launched for you.'),
    harness ?? '',
  )
  const docText = readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'docs', 'BLENDER-BRIDGE.md'),
    'utf8',
  )
  check('docs/BLENDER-BRIDGE.md carries the policy sentence', docText.includes(policySentence))
  const { validateToolCapability } = await import('../../src/utils/capability/contract.js')
  const { blenderBridgeVerbNames } = await import('../../src/services/blender/bridgeProtocol.js')
  const cap = BlenderTool.capability
  const expectedOps = [
    ...blenderBridgeVerbNames(),
    'blender_status',
    'blender_bridge_install',
    'blender_bridge_uninstall',
  ]
  check(
    'capability contract is valid and lists every wire and local operation',
    cap != null &&
      validateToolCapability(cap).ok &&
      JSON.stringify(cap.operations) === JSON.stringify(expectedOps),
    JSON.stringify(cap?.operations ?? null),
  )
  check(
    'capability conditions state both roads (running Blender with add-on OR located Blender for headless -b)',
    (cap?.conditions ?? []).some(
      c => c.includes('mercury_blender_bridge') && c.includes('headless -b'),
    ),
    JSON.stringify(cap?.conditions ?? []),
  )
  check(
    'capability intents cover both the bridge and headless -b roads without claiming a running Blender is the only road',
    (cap?.intents ?? []).some(i => i.includes('headless -b')) &&
      !(cap?.intents ?? []).some(i => i.includes('running blender')),
    JSON.stringify(cap?.intents ?? []),
  )
  process.env.MERCURY_BLENDER_BIN = noBlender
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
  check('blender_bridge_uninstall ⇒ mutate ask naming the entire add-on directory removal (token and config included)', uninstall.behavior === 'ask' && /removes the entire mercury_blender_bridge add-on directory \(token and config included\)/.test(uninstall.message ?? ''))
  check('unknown ⇒ allow (the teaching path never reaches Blender)', (await perm('made_up')).behavior === 'allow')
  check(
    'isReadOnly mirrors the classes (+ blender_status)',
    BlenderTool.isReadOnly!({ op: 'scene_info' } as never) &&
      BlenderTool.isReadOnly!({ op: 'blender_status' } as never) &&
      !BlenderTool.isReadOnly!({ op: 'blend_open' } as never) &&
      !BlenderTool.isReadOnly!({ op: 'python_run' } as never),
  )
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
  check('scene_info answers through the tool', info.includes('"engine": "BLENDER_EEVEE"'))
  const outputPath = path.join(realpathSync(work), 'renders', 'frame.png')
  const still = await runWithCwdOverride(work, () => callTool('render_still', { outputPath: path.join('renders', 'frame.png'), frame: 1 }))
  check('render_still acks started with the RESOLVED (real) outputPath', still.includes('"started": true') && still.includes(outputPath))
  await sleep(120)
  const after = await runWithCwdOverride(work, () => callTool('render_state'))
  check('the durable file landed at the fenced path', existsSync(outputPath))
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

section('§6 · the contract promises no cancellation: an abort does not end a request the bridge is holding')
{
  process.env.MERCURY_BLENDER = '1'
  process.env.MERCURY_BLENDER_BIN = noBlender
  process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = addonHome
  resetBlenderBridgeClientForTest()
  _resetBlenderBridgeContextCacheForTesting()
  const held = await startFakeBlenderBridge({ token: 'tok', mode: 'silent-after-hello' })
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(held.port)
  const controller = new AbortController()
  let settled = false
  const pending = runWithCwdOverride(work, () =>
    BlenderTool.call({ op: 'scene_info' } as never, { abortController: controller } as never),
  ).then(r => {
    settled = true
    return r as { data: { result: string } }
  })
  const until = Date.now() + 2_000
  while (!held.seenOps.includes('scene_info') && Date.now() < until) await sleep(5)
  controller.abort()
  await sleep(150)
  const pendingAfterAbort = !settled
  await held.close()
  const answer = await pending
  check('the bridge had received the operation when the abort came', held.seenOps.includes('scene_info'))
  check(
    'the aborted call is still waiting 150 ms later and settles only when the connection ends',
    pendingAfterAbort && answer.data.result.includes('[CONNECTION_LOST]'),
    `pending after abort=${pendingAfterAbort} · ${answer.data.result.split('\n').slice(0, 2).join(' | ').slice(0, 160)}`,
  )
  check(
    'so the capability contract says not-applicable, and neither cooperative nor kill',
    BlenderTool.capability?.cancellation === 'not-applicable',
    String(BlenderTool.capability?.cancellation),
  )
  delete process.env.MERCURY_BLENDER_BRIDGE_PORT
  delete process.env.MERCURY_BLENDER_BIN
  resetBlenderBridgeClientForTest()
  delete process.env.MERCURY_BLENDER
}

console.log('\n' + (failures === 0 ? '✅ blender-bridge tool proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
