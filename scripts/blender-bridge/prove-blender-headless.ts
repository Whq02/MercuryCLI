#!/usr/bin/env bun

process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createFakeBlenderFixture } from './fake-blender.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const savedEnv = { ...process.env }
function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
}

for (const k of [
  'MERCURY_BLENDER',
  'MERCURY_BLENDER_BIN',
  'MERCURY_BLENDER_BRIDGE_PORT',
  'MERCURY_BLENDER_BRIDGE_TOKEN',
  'MERCURY_BLENDER_BRIDGE_ADDON_DIR',
  'BLENDER_USER_SCRIPTS',
  'BLENDER_USER_RESOURCES',
  'FAKE_BLENDER_C_STDOUT',
  'FAKE_BLENDER_C_STDERR',
  'FAKE_BLENDER_RENDER_SLEEP_MS',
]) {
  delete process.env[k]
}

async function freshDeadPort(): Promise<number> {
  return new Promise<number>(resolve => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { BlenderTool } = await import('../../src/tools/BlenderTool/BlenderTool.js')
const proto = (await import('../../src/services/blender/bridgeProtocol.js')) as Record<string, unknown>
const { resetBlenderBridgeClientForTest } = await import('../../src/services/blender/bridgeClient.js')
const { _resetBlenderBridgeContextCacheForTesting } = await import('../../src/utils/blender/bridgeGates.js')
const installer = await import('../../src/services/blender/bridgeInstaller.js')
const { readBlenderBridgeToken } = await import('../../src/services/blender/bridgeToken.js')
const { startFakeBlenderBridge } = await import('./fake-bridge.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-headless-proof-'))
const work = path.join(scratch, 'studio')
mkdirSync(work, { recursive: true })
const addonHome = path.join(scratch, 'addons')
mkdirSync(addonHome, { recursive: true })
const fixture = createFakeBlenderFixture(path.join(scratch, 'bin'), { version: '5.3.0' })

const callTool = async (op: string, args?: Record<string, unknown>): Promise<string> => {
  const r = (await BlenderTool.call({ op, ...(args ? { args } : {}) } as never, {} as never)) as {
    data: { result: string }
  }
  return r.data.result
}

const deadPort = await freshDeadPort()
process.env.MERCURY_BLENDER = '1'
process.env.MERCURY_BLENDER_BIN = fixture.bin
process.env.MERCURY_BLENDER_BRIDGE_PORT = String(deadPort)
process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = addonHome
resetBlenderBridgeClientForTest()
_resetBlenderBridgeContextCacheForTesting()

section('§1 · armed, Blender located, no client reachable: raising python_run answers non-zero exit + whole traceback')
{
  const deepRaisingScript = [
    'import sys',
    'print("frame 1 ok")',
    'sys.stderr.write("rig stderr note\\n")',
    ...Array.from({ length: 15 }, (_, i) =>
      i < 14
        ? `def step_${String(i + 1).padStart(2, '0')}():\n    return step_${String(i + 2).padStart(2, '0')}()`
        : `def step_15():\n    raise ValueError("bad broadcast shape (355,198,3) -> (357,198,3)")`,
    ),
    'step_01()',
  ].join('\n')

  process.env.FAKE_BLENDER_C_STDERR = 'WARN (bpy.rna): C-level engine warning\n'
  const out = await runWithCwdOverride(work, () => callTool('python_run', { source: deepRaisingScript }))
  delete process.env.FAKE_BLENDER_C_STDERR

  check(
    'does not answer that the bridge is unavailable',
    !out.includes('the Blender bridge is not available here'),
    out.slice(0, 140),
  )
  check('names the headless road', /road:\s*headless/.test(out) && out.includes(fixture.bin), out.slice(0, 140))
  check('carries the non-zero process exit status', /exit status:\s*[1-9]\d*/.test(out), out.slice(0, 160))
  check(
    'carries the whole traceback from top frame to final exception (not cut to 12 lines)',
    out.includes('Traceback (most recent call last):') &&
      out.includes('in step_01') &&
      out.includes('in step_15') &&
      out.includes('ValueError: bad broadcast shape (355,198,3) -> (357,198,3)'),
    out.slice(0, 220),
  )
  check(
    'returns script stdout and stderr apart, and Blender C-level lines apart from both',
    out.includes('frame 1 ok') &&
      out.includes('rig stderr note') &&
      out.includes('WARN (bpy.rna): C-level engine warning'),
  )
  check(
    'suppresses Blender banner structurally via -q (no banner lines in the answer)',
    !out.includes('hash deadbeef') && !out.includes('Blender quit'),
  )
  check('wrote nothing to the user add-on home', readdirSync(addonHome).length === 0)
}

section('§2 · CLI flags contract + one process per call, nothing left running')
{
  const calls = fixture.invocations()
  check('started exactly one Blender process for the call', calls.length === 1, `calls=${calls.length}`)
  const argv = calls[0]?.argv ?? []
  const exitIdx = argv.indexOf('--python-exit-code')
  const pyIdx = argv.indexOf('--python')
  const sepIdx = argv.indexOf('--')
  check(
    'passes -b -q --factory-startup --python-exit-code <n> --offline-mode --python <driver> -- <req>',
    argv.includes('-b') &&
      argv.includes('-q') &&
      argv.includes('--factory-startup') &&
      exitIdx >= 0 &&
      Number(argv[exitIdx + 1]) > 0 &&
      argv.includes('--offline-mode') &&
      pyIdx >= 0 &&
      typeof argv[pyIdx + 1] === 'string' &&
      sepIdx > pyIdx &&
      argv.length > sepIdx + 1,
    argv.join(' '),
  )
  check(
    'never passes -y or system/user Python flags',
    !argv.includes('-y') &&
      !argv.includes('--enable-autoexec') &&
      !argv.includes('--python-use-system-env') &&
      !argv.includes('--python-use-user-env'),
    argv.join(' '),
  )
  check('nothing left running after the call returns', calls[0] !== undefined && !pidAlive(calls[0].pid))
}

section('§3 · python_run value, bounded stdout/stderr tails apart, Blender C-level lines apart, stateless across calls')
{
  fixture.clearInvocations()
  process.env.FAKE_BLENDER_C_STDOUT = 'Fra:1 Mem:24.00M (Peak 28.00M)\n'
  const bigRun = await runWithCwdOverride(work, () =>
    callTool('python_run', {
      source: [
        'import sys',
        'persisted_marker = 777',
        'sys.stdout.write("A" * 35000 + "\\nTAIL_SUMMARY_LINE\\n")',
        'sys.stderr.write("script_stderr_only\\n")',
        'result = {"frames": 36, "clipped": 0}',
      ].join('\n'),
    }),
  )
  delete process.env.FAKE_BLENDER_C_STDOUT
  check('exit status 0 on clean run', /exit status:\s*0\b/.test(bigRun), bigRun.slice(0, 120))
  check('returns result repr', bigRun.includes("'frames': 36") && bigRun.includes("'clipped': 0"))
  check(
    'bounds oversized stdout to 32 KiB tail with truncation counted and keeps final summary',
    bigRun.includes('TAIL_SUMMARY_LINE') && /"stdout":\s*[1-9]\d*/.test(bigRun),
  )
  check('keeps script stderr apart from script stdout', bigRun.includes('script_stderr_only'))
  check('keeps Blender C-level stdout apart from script streams', bigRun.includes('Fra:1 Mem:24.00M'))

  const secondRun = await runWithCwdOverride(work, () =>
    callTool('python_run', { source: 'result = "persisted_marker" in globals()' }),
  )
  check('no state survives between headless calls (fresh process each call)', secondRun.includes('"value": "False"'))
  const calls = fixture.invocations()
  check(
    'each call spawned its own fresh pid and both exited',
    calls.length === 2 &&
      calls[0]!.pid !== calls[1]!.pid &&
      !pidAlive(calls[0]!.pid) &&
      !pidAlive(calls[1]!.pid),
  )
}

section('§4 · headless scene/objects/render_state/report_tail/blend_open + fenced blend arg + render_still execute form & ceiling')
{
  const blendPath = path.join(work, 'unit.blend')
  writeFileSync(
    blendPath,
    JSON.stringify({ custom_objects: ['LegionaryMesh', 'LegionaryRig'], engine: 'CYCLES', frameEnd: 80 }),
  )
  const info = await runWithCwdOverride(work, () => callTool('scene_info', { blend: 'unit.blend' }))
  check(
    'scene_info opens the named .blend and answers headless',
    /road:\s*headless/.test(info) &&
      info.includes(realpathSync(blendPath)) &&
      info.includes('"engine": "CYCLES"') &&
      info.includes('"frameEnd": 80'),
    info.slice(0, 180),
  )
  const objs = await runWithCwdOverride(work, () => callTool('objects_list', { blend: 'unit.blend' }))
  check(
    'objects_list walks the named .blend',
    objs.includes('LegionaryMesh') && objs.includes('LegionaryRig'),
    objs.slice(0, 180),
  )
  const rstate = await runWithCwdOverride(work, () => callTool('render_state', { blend: 'unit.blend' }))
  check(
    'render_state answers with jobs false and scene settings',
    rstate.includes('"render": false') && rstate.includes('"engine": "CYCLES"'),
  )
  const tail = await runWithCwdOverride(work, () => callTool('report_tail', { blend: 'unit.blend' }))
  check('report_tail carries lifecycle load entry', tail.includes('unit.blend') && tail.includes('"entries"'))
  const opened = await runWithCwdOverride(work, () => callTool('blend_open', { path: 'unit.blend' }))
  check('blend_open validates and opens the fenced .blend', opened.includes('"opened"') && opened.includes(realpathSync(blendPath)))
  check(
    'blend_open headless says the file opened cleanly and was closed with the process',
    opened.includes('opened cleanly and was closed with the process') &&
      opened.includes('"closedWithProcess": true'),
    opened.slice(0, 220),
  )
  const missingBlend = await runWithCwdOverride(work, () => callTool('scene_info', { blend: 'nope.blend' }))
  check('missing .blend answers BLEND_NOT_FOUND with non-zero exit status', missingBlend.includes('[BLEND_NOT_FOUND]') && /exit status:\s*[1-9]/.test(missingBlend))
  const stillPath = path.join(realpathSync(work), 'renders', 'frame07.png')
  const still = await runWithCwdOverride(work, () =>
    callTool('render_still', { blend: 'unit.blend', outputPath: 'renders/frame07.png', frame: 7 }),
  )
  const pyClean = await runWithCwdOverride(work, () => callTool('python_run', { source: 'result = 2' }))
  check(
    'every headless answer carries one short line that the process has ended and no state is kept (naming blend for the next call)',
    [info, objs, rstate, tail, opened, missingBlend, still, pyClean].every(ans =>
      /^state: process ended, no state kept \(name blend on the next call\)$/m.test(ans),
    ),
    info.slice(0, 180),
  )

  fixture.clearInvocations()
  const escapedBlend = await runWithCwdOverride(work, () => callTool('scene_info', { blend: '../outside.blend' }))
  const escapedOut = await runWithCwdOverride(work, () =>
    callTool('render_still', { blend: 'unit.blend', outputPath: '../outside.png' }),
  )
  check(
    'fences blend and outputPath to the working tree before any Blender process starts',
    /must stay inside the working tree/.test(escapedBlend) &&
      /must stay inside the working tree/.test(escapedOut) &&
      fixture.invocations().length === 0,
  )
  check(
    'render_still runs execute form and returns once the frame is on disk with duration',
    existsSync(stillPath) &&
      readFileSync(stillPath, 'utf8') === 'FAKE-HEADLESS-PNG:7\n' &&
      still.includes('"finished": true') &&
      still.includes('"frame": 7') &&
      /"durationMs":\s*\d+/.test(still),
    still.slice(0, 200),
  )
  check(
    'render_still has its own render time ceiling above the 30s bridge request ceiling',
    typeof proto.BLENDER_HEADLESS_RENDER_TIMEOUT_MS === 'number' &&
      (proto.BLENDER_HEADLESS_RENDER_TIMEOUT_MS as number) > 30_000,
    String(proto.BLENDER_HEADLESS_RENDER_TIMEOUT_MS),
  )

  fixture.clearInvocations()
  process.env.FAKE_BLENDER_RENDER_SLEEP_MS = '3000'
  const timedOut = await runWithCwdOverride(work, () =>
    callTool('render_still', { blend: 'unit.blend', outputPath: 'renders/slow.png', timeoutMs: 150 }),
  )
  delete process.env.FAKE_BLENDER_RENDER_SLEEP_MS
  const slowCall = fixture.invocations()[0]
  check(
    'a render exceeding its ceiling is terminated and leaves no Blender process running',
    timedOut.includes('[REQUEST_TIMEOUT]') && slowCall !== undefined && !pidAlive(slowCall.pid),
    timedOut.slice(0, 160),
  )
}

section('§5 · window-requiring ops refused honestly · road precedence · permission parity')
{
  const opengl = await runWithCwdOverride(work, () =>
    callTool('python_run', { source: 'import bpy\nbpy.ops.render.opengl(write_still=True)' }),
  )
  check(
    'a window-requiring bpy operator in python_run answers as the script error naming the operator and the open-Blender add-on road',
    opengl.includes('bpy.ops.render.opengl') &&
      /window/i.test(opengl) &&
      opengl.includes('mercury_blender_bridge') &&
      /exit status:\s*[1-9]/.test(opengl),
    opengl.slice(0, 220),
  )

  fixture.clearInvocations()
  const jobRefusal = await runWithCwdOverride(work, () =>
    callTool('render_still', { blend: 'unit.blend', outputPath: 'renders/job.png', invoke: true }),
  )
  check(
    'render_still job/invoke form refuses without starting a process, without inventing an exit status, naming the window requirement and bridge road',
    fixture.invocations().length === 0 &&
      !/exit status:/i.test(jobRefusal) &&
      /no Blender process was started/i.test(jobRefusal) &&
      /render_still/.test(jobRefusal) &&
      /window/i.test(jobRefusal) &&
      jobRefusal.includes('mercury_blender_bridge'),
    jobRefusal.slice(0, 220),
  )

  fixture.clearInvocations()
  const unknownWinName = await runWithCwdOverride(work, () => callTool('render_opengl'))
  check(
    'an uncatalogued op name takes the unknown-op teaching path with no invented exit status',
    unknownWinName.includes('unknown op "render_opengl"') &&
      !/exit status:/i.test(unknownWinName) &&
      fixture.invocations().length === 0,
    unknownWinName.slice(0, 180),
  )

  installer.applyBlenderBridgeInstall()
  resetBlenderBridgeClientForTest()
  const headlessEvenWithToken = await runWithCwdOverride(work, () => callTool('scene_info'))
  check(
    'with token on disk and no bridge listening, falls through to headless road',
    /road:\s*headless/.test(headlessEvenWithToken),
    headlessEvenWithToken.slice(0, 120),
  )

  const token = readBlenderBridgeToken(addonHome)!
  const fakeBridge = await startFakeBlenderBridge({ token })
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(fakeBridge.port)
  resetBlenderBridgeClientForTest()
  fixture.clearInvocations()
  const overBridge = await runWithCwdOverride(work, () => callTool('scene_info'))
  check(
    'when a bridge client IS reachable, takes the bridge road and spawns zero headless processes',
    /road:\s*bridge/.test(overBridge) && fixture.invocations().length === 0,
    overBridge.slice(0, 120),
  )
  await fakeBridge.close()
  resetBlenderBridgeClientForTest()

  const perm = async (op: string, args?: Record<string, unknown>) =>
    (await BlenderTool.checkPermissions!({ op, ...(args ? { args } : {}) } as never, {} as never)) as {
      behavior: string
    }
  check(
    'asks match the window road: reads allow, mutates and execs ask every time',
    (await perm('scene_info', { blend: 'unit.blend' })).behavior === 'allow' &&
      (await perm('objects_list', { blend: 'unit.blend' })).behavior === 'allow' &&
      (await perm('render_state', { blend: 'unit.blend' })).behavior === 'allow' &&
      (await perm('report_tail', { blend: 'unit.blend' })).behavior === 'allow' &&
      (await perm('blend_open', { path: 'unit.blend' })).behavior === 'ask' &&
      (await perm('render_still', { blend: 'unit.blend', outputPath: 'renders/x.png' })).behavior === 'ask' &&
      (await perm('python_run', { source: 'x = 1' })).behavior === 'ask',
  )
}

section('§6 · --disable-autoexec explicit on every headless op (a free read opening a .blend never runs embedded Python)')
{
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(await freshDeadPort())
  resetBlenderBridgeClientForTest()
  fixture.clearInvocations()
  const markerPath = path.join(scratch, 'autoexec-ran.txt')
  const trappedBlend = path.join(work, 'trapped.blend')
  writeFileSync(trappedBlend, JSON.stringify({ autoexec_marker_path: markerPath }))
  await runWithCwdOverride(work, () => callTool('scene_info', { blend: 'trapped.blend' }))
  await runWithCwdOverride(work, () => callTool('objects_list', { blend: 'trapped.blend' }))
  await runWithCwdOverride(work, () => callTool('render_state', { blend: 'trapped.blend' }))
  await runWithCwdOverride(work, () => callTool('report_tail', { blend: 'trapped.blend' }))
  await runWithCwdOverride(work, () => callTool('blend_open', { path: 'trapped.blend' }))
  await runWithCwdOverride(work, () =>
    callTool('render_still', { blend: 'trapped.blend', outputPath: 'renders/trapped.png', frame: 1 }),
  )
  await runWithCwdOverride(work, () => callTool('python_run', { blend: 'trapped.blend', source: 'result = 1' }))
  const runs = fixture.invocations()
  check('all seven wire verbs spawned headless runs', runs.length === 7, `runs=${runs.length}`)
  check(
    'every op passes --disable-autoexec explicitly in argv',
    runs.length === 7 && runs.every(r => r.argv.includes('--disable-autoexec')),
    runs.map(r => r.argv.join(' ')).slice(0, 1).join(''),
  )
  check(
    'no op ever passes -y or --enable-autoexec in argv',
    runs.length === 7 && runs.every(r => !r.argv.includes('-y') && !r.argv.includes('--enable-autoexec')),
  )
  check('opening a .blend on a free read never ran embedded autoexec Python', !existsSync(markerPath))
}

section('§7 · blender_status with no window (B-2, B-3): binary + source, versions, modules, API notes, one start per binary kept')
{
  const { getBlenderToolDescription } = await import('../../src/tools/BlenderTool/prompt.js')
  const fixture5 = createFakeBlenderFixture(path.join(scratch, 'bin5'), { version: '5.3.0', name: 'blender5' })
  const fixture4 = createFakeBlenderFixture(path.join(scratch, 'bin4'), { version: '4.5.13', name: 'blender4' })
  const userScripts = path.join(scratch, 'user-scripts')
  mkdirSync(userScripts, { recursive: true })
  delete process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR
  process.env.BLENDER_USER_SCRIPTS = userScripts
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(await freshDeadPort())
  const descBefore = getBlenderToolDescription()
  process.env.MERCURY_BLENDER_BIN = fixture5.bin
  resetBlenderBridgeClientForTest()

  const s1 = await runWithCwdOverride(work, () => callTool('blender_status'))
  check(
    'names the located binary and how it was found',
    s1.includes(fixture5.bin) && /\bpin\b/.test(s1),
    s1.slice(0, 160),
  )
  check('reports Blender version', /\b5\.3\.0\b/.test(s1), s1.slice(0, 180))
  check('reports Blender embedded Python version', /python:\s*3\.\d+\.\d+/i.test(s1), s1.slice(0, 220))
  check(
    'reports fixed list of bundled and non-bundled Python modules',
    s1.includes('numpy 2.3.4') &&
      s1.includes('mathutils') &&
      s1.includes('bmesh') &&
      s1.includes('PIL') &&
      s1.includes('scipy'),
    s1.slice(0, 260),
  )
  check(
    'reports 5.x Python API notes URL with the channelbags Action clause',
    s1.includes('https://developer.blender.org/docs/release_notes/5.3/python_api/') &&
      s1.includes('the legacy Action API is gone: F-curves live on channelbags'),
    s1.slice(0, 280),
  )
  delete process.env.BLENDER_USER_SCRIPTS
  process.env.HOME = path.join(scratch, 'fake-home')
  mkdirSync(process.env.HOME, { recursive: true })
  const s2 = await runWithCwdOverride(work, () => callTool('blender_status'))
  const s3 = await runWithCwdOverride(work, () => callTool('blender_status'))
  check(
    'starts Blender at most once per binary with --disable-autoexec and keeps the result across calls',
    fixture5.invocations().length === 1 &&
      fixture5.invocations()[0]!.argv.includes('--disable-autoexec') &&
      s2.includes('5.3.0') &&
      s3.includes('5.3.0'),
    `starts=${fixture5.invocations().length}`,
  )

  process.env.MERCURY_BLENDER_BIN = fixture4.bin
  const s4 = await runWithCwdOverride(work, () => callTool('blender_status'))
  check(
    '4.x binary reports 4.5 Python API notes URL WITHOUT the 5+ channelbags clause',
    s4.includes('https://developer.blender.org/docs/release_notes/4.5/python_api/') &&
      !s4.includes('channelbags') &&
      fixture4.invocations().length === 1,
    `starts4=${fixture4.invocations().length}`,
  )

  process.env.MERCURY_BLENDER_BIN = fixture5.bin
  await runWithCwdOverride(work, () => callTool('blender_status'))
  check(
    'returning to an earlier binary reuses its kept probe with zero extra starts',
    fixture5.invocations().length === 1 && fixture4.invocations().length === 1,
    `starts5=${fixture5.invocations().length} starts4=${fixture4.invocations().length}`,
  )

  process.env.MERCURY_BLENDER_BIN = path.join(scratch, 'no-such-blender')
  const sMissing = await runWithCwdOverride(work, () => callTool('blender_status'))
  check('when unlocated, names MERCURY_BLENDER_BIN', sMissing.includes('MERCURY_BLENDER_BIN'))
  check('the tool prompt gains nothing from B-3', getBlenderToolDescription() === descBefore && !descBefore.includes('channelbags'))
}

restoreEnv()
rmSync(scratch, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? '✅ blender headless proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
