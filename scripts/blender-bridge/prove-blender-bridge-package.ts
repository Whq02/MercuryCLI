#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BLENDER_BRIDGE_DIGEST,
  BLENDER_BRIDGE_FILES,
} from '../../src/integrations/blender/bridgeFiles.generated.js'
import {
  BLENDER_BRIDGE_PROTOCOL_VERSION,
  BLENDER_BRIDGE_DEFAULT_PORT,
  BLENDER_BRIDGE_MAX_LINE_BYTES,
  BLENDER_BRIDGE_OBJECTS_NODE_CAP,
  BLENDER_BRIDGE_REPORT_RING_CAP,
  BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES,
  BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES,
  blenderBridgeVerbNames,
} from '../../src/integrations/blender-protocol/bridgeProtocol.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function file(p: string): string {
  return BLENDER_BRIDGE_FILES.find(f => f.path === p)?.content ?? ''
}

const MOD = 'mercury_blender_bridge'

const PROBE = [
  'import importlib.util, json, logging, sys, types',
  'sys.dont_write_bytecode = True',
  'd = sys.argv[1]',
  "pkg = types.ModuleType('mbb'); pkg.__path__ = [d]; sys.modules['mbb'] = pkg",
  "handlers = types.ModuleType('bpy.app.handlers'); handlers.persistent = lambda f: f",
  "app = types.ModuleType('bpy.app'); app.handlers = handlers",
  "bpy = types.ModuleType('bpy'); bpy.app = app",
  'bpy.context = types.SimpleNamespace(scene=None); bpy.data = types.SimpleNamespace(scenes=[], filepath="")',
  "sys.modules.update({'bpy': bpy, 'bpy.app': app, 'bpy.app.handlers': handlers})",
  'def load(name):',
  "    spec = importlib.util.spec_from_file_location('mbb.' + name, d + '/' + name + '.py')",
  "    mod = importlib.util.module_from_spec(spec); sys.modules['mbb.' + name] = mod; spec.loader.exec_module(mod); return mod",
  "state = load('state'); ring = load('ring'); server = load('server'); ops = load('ops')",
  "out = {'python': sys.version.split()[0]}",
  "record = logging.LogRecord('probe', logging.ERROR, 'probe', 1, 'a line', (), None)",
  'append = ring._append',
  'def refuse(*a, **k):',
  "    raise RuntimeError('the ring refused')",
  'ring._append = refuse',
  'try:',
  '    ring._RingLogHandler().emit(record)',
  "    out['emitWithAppendRaising'] = 'returned'",
  'except Exception as error:',
  "    out['emitWithAppendRaising'] = 'raised ' + type(error).__name__",
  'ring._append = append',
  "held = len(ring.tail()['entries'])",
  'try:',
  '    ring._RingLogHandler().emit(record)',
  'except Exception as error:',
  "    out['emitError'] = type(error).__name__",
  "out['emitAppends'] = len(ring.tail()['entries']) - held",
  'seen = []',
  'server.emit = lambda event, data: seen.append(event)',
  "state.render_job['active'] = False",
  "held = len(ring.tail()['entries'])",
  'try:',
  '    ops._on_render_complete(None); ops._on_render_cancel(None)',
  'except Exception as error:',
  "    out['notOursError'] = type(error).__name__",
  "out['eventsNotOurs'] = list(seen); out['reportsNotOurs'] = len(ring.tail()['entries']) - held",
  'del seen[:]',
  "state.render_job.update({'active': True, 'outputPath': d + '/no-such-render.png', 'frame': 1, 'prev_filepath': '', 'prev_frame': 1, 'started_at': 0.0})",
  'try:',
  '    ops._on_render_complete(None)',
  'except Exception as error:',
  "    out['oursError'] = type(error).__name__",
  "out['eventsOurs'] = list(seen); out['activeAfter'] = state.render_job['active']",
  'import socket, time',
  "token = d + '/probe-token'",
  "open(token, 'w', encoding='utf-8').write('probe-token-value')",
  'bridge = server.BridgeServer(0, token)',
  'def said(sock):',
  "    data = b''",
  "    while not data.endswith(b'\\n'):",
  '        chunk = sock.recv(65536)',
  '        if not chunk:',
  '            return None',
  '        data += chunk',
  "    return json.loads(data.decode('utf-8').split('\\n')[0])",
  'def dial():',
  "    sock = socket.create_connection(('127.0.0.1', bridge.listener.getsockname()[1]), timeout=5)",
  '    sock.settimeout(5)',
  '    return sock',
  "hello = (json.dumps({'op': 'hello', 'token': 'probe-token-value', 'version': state.PROTOCOL_VERSION}) + '\\n').encode('utf-8')",
  "ping = (json.dumps({'id': 7, 'op': 'ping'}) + '\\n').encode('utf-8')",
  'try:',
  '    if bridge.start():',
  '        first = dial(); first.sendall(hello); greeted = said(first)',
  '        probe = dial()',
  '        time.sleep(0.3)',
  '        first.sendall(ping); pong = said(first)',
  '        probe.sendall(hello); taken = said(probe)',
  '        try:',
  "            dropped = first.recv(65536) == b''",
  '        except OSError:',
  '            dropped = True',
  "        out['newest'] = {'firstGreeted': bool(greeted and greeted.get('ok')), 'firstAnswersBesideAProbe': bool(pong and pong.get('id') == 7 and pong.get('ok')), 'secondGreeted': bool(taken and taken.get('ok')), 'firstDroppedAtSecondHello': dropped}",
  'except Exception as error:',
  "    out['newestError'] = type(error).__name__ + ': ' + str(error)",
  'finally:',
  '    bridge.stop()',
  'print(json.dumps(out))',
  '',
].join('\n')

type BridgeProbe = { python?: string; emitWithAppendRaising?: string; emitAppends?: number; eventsNotOurs?: string[]; reportsNotOurs?: number; eventsOurs?: string[]; activeAfter?: boolean; newest?: { firstGreeted: boolean; firstAnswersBesideAProbe: boolean; secondGreeted: boolean; firstDroppedAtSecondHello: boolean }; newestError?: string }

type BridgeRun = { ran: string; probe: BridgeProbe; said: string }
let bridgeRun: BridgeRun | null = null
function bridgeUnderPython(): BridgeRun {
  bridgeRun ??= runBridgeUnderPython()
  return bridgeRun
}

function runBridgeUnderPython(): BridgeRun {
  const pack = join(import.meta.dir, '..', '..', 'vendor', 'python', 'extracted', `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`, process.platform === 'win32' ? 'python.exe' : join('bin', 'python3'))
  const python = existsSync(pack) ? pack : 'python3'
  const home = mkdtempSync(join(tmpdir(), 'blender-bridge-probe-'))
  try {
    for (const f of BLENDER_BRIDGE_FILES) {
      mkdirSync(dirname(join(home, f.path)), { recursive: true })
      writeFileSync(join(home, f.path), f.content)
    }
    writeFileSync(join(home, 'probe.py'), PROBE)
    const run = spawnSync(python, ['-B', join(home, 'probe.py'), join(home, MOD)], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 30_000 })
    const said = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim()
    let probe: BridgeProbe = {}
    try {
      probe = JSON.parse((run.stdout ?? '').trim().split('\n').at(-1) ?? '') as BridgeProbe
    } catch {
      probe = {}
    }
    return { ran: `${existsSync(pack) ? 'the vendored Python' : 'python3 on PATH (no vendored pack here)'} ${probe.python ?? '?'}`, probe, said }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

section('1. the bundle — files present, digest sane')
{
  const expected = [
    `${MOD}/README.md`,
    `${MOD}/__init__.py`,
    `${MOD}/ops.py`,
    `${MOD}/pump.py`,
    `${MOD}/ring.py`,
    `${MOD}/server.py`,
    `${MOD}/state.py`,
  ]
  check(
    'exactly the expected files, sorted',
    JSON.stringify(BLENDER_BRIDGE_FILES.map(f => f.path)) === JSON.stringify(expected),
    BLENDER_BRIDGE_FILES.map(f => f.path).join(','),
  )
  check('64-hex digest', /^[0-9a-f]{64}$/.test(BLENDER_BRIDGE_DIGEST))
  check('every file non-empty', BLENDER_BRIDGE_FILES.every(f => f.content.length > 0))
  check(
    'no bytecode shipped (__pycache__/.pyc never bake)',
    BLENDER_BRIDGE_FILES.every(f => !f.path.includes('__pycache__') && !f.path.endsWith('.pyc')),
  )
  check(
    'neither token nor config.json ship in the bundle (the installer writes those)',
    BLENDER_BRIDGE_FILES.every(f => !f.path.endsWith('/token') && !f.path.endsWith('/config.json')),
  )
}

section('2. bl_info — the legacy-add-on identity (the ruling)')
{
  const init = file(`${MOD}/__init__.py`)
  check('bl_info present', init.includes('bl_info = {'))
  check('name is the product spelling', init.includes('"name": "Mercury Blender Bridge"'))
  check('category Development', init.includes('"category": "Development"'))
  check('version tuple present', /"version": \(\d+, \d+, \d+\)/.test(init))
  check(
    'blender floor 4.2 (the extensions-era line both LTS releases clear)',
    init.includes('"blender": (4, 2, 0)'),
  )
  check('register/unregister both defined', init.includes('def register():') && init.includes('def unregister():'))
  const registerBody = init.slice(init.indexOf('def register():'), init.indexOf('def unregister():'))
  check(
    'register() reads no member of bpy.data: Blender enables an add-on with bpy.data swapped for a _RestrictData (addon_utils.enable runs register() inside RestrictBlend), so a read there fails the enable',
    registerBody.length > 0 && !registerBody.includes('bpy.data.'),
    registerBody.match(/bpy\.data\.\w+/)?.[0],
  )
  check('the port config road reads config.json beside the add-on', init.includes('config.json') && init.includes('_config_port'))
  check('the token path is the file beside the add-on', init.includes('os.path.join(os.path.dirname(__file__), "token")'))
}

section('3. the contract constants — ONE truth, two languages')
{
  const state = file(`${MOD}/state.py`)
  check(`PROTOCOL_VERSION = ${BLENDER_BRIDGE_PROTOCOL_VERSION}`, state.includes(`PROTOCOL_VERSION = ${BLENDER_BRIDGE_PROTOCOL_VERSION}\n`))
  check(`DEFAULT_PORT = ${BLENDER_BRIDGE_DEFAULT_PORT}`, state.includes(`DEFAULT_PORT = ${BLENDER_BRIDGE_DEFAULT_PORT}`))
  check('MAX_LINE_BYTES = 8 * 1024 * 1024', state.includes('MAX_LINE_BYTES = 8 * 1024 * 1024') && BLENDER_BRIDGE_MAX_LINE_BYTES === 8 * 1024 * 1024)
  check(`OBJECTS_NODE_CAP = ${BLENDER_BRIDGE_OBJECTS_NODE_CAP}`, state.includes(`OBJECTS_NODE_CAP = ${BLENDER_BRIDGE_OBJECTS_NODE_CAP}`))
  check(`REPORT_RING_CAP = ${BLENDER_BRIDGE_REPORT_RING_CAP}`, state.includes(`REPORT_RING_CAP = ${BLENDER_BRIDGE_REPORT_RING_CAP}`))
  check('PYTHON_SOURCE_CAP_BYTES = 64 * 1024', state.includes('PYTHON_SOURCE_CAP_BYTES = 64 * 1024') && BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES === 64 * 1024)
  check('PYTHON_OUTPUT_CAP_BYTES = 32 * 1024', state.includes('PYTHON_OUTPUT_CAP_BYTES = 32 * 1024') && BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES === 32 * 1024)
  check('the unauthed deadline is 10s', state.includes('UNAUTHED_DEADLINE_S = 10.0'))
  const verbTuple = state.match(/VERBS = \(([^)]+)\)/s)?.[1] ?? ''
  const pyVerbs = [...verbTuple.matchAll(/"([a-z_]+)"/g)].map(m => m[1])
  check(
    'the Python VERBS tuple equals the TypeScript verb table, in order',
    JSON.stringify(pyVerbs) === JSON.stringify(blenderBridgeVerbNames()),
    pyVerbs.join(','),
  )
  const ops = file(`${MOD}/ops.py`)
  for (const verb of blenderBridgeVerbNames()) {
    check(`ops.HANDLERS carries "${verb}"`, new RegExp(`"${verb}": ${verb}`).test(ops))
  }
}

section('4. the main-thread law lives in the source')
{
  const server = file(`${MOD}/server.py`)
  check('server.py imports NO bpy (the load-bearing pin)', !/^\s*(import bpy|from bpy)/m.test(server))
  check(
    'loopback only by construction (the bind itself, not just the docstring)',
    server.includes('listener.bind(("127.0.0.1"') && !/bind\(\("0\.0\.0\.0"/.test(server),
  )
  check('the command queue is the one road to the main thread', server.includes('command_queue = queue.Queue()'))
  const newest = bridgeUnderPython()
  check(
    'accept-newest fires at HELLO time (probe-immune)',
    newest.probe.newest !== undefined && Object.values(newest.probe.newest).every(held => held === true),
    `under ${newest.ran}, the add-on's own server on a loopback port: ${JSON.stringify(newest.probe.newest ?? newest.probe.newestError ?? newest.said.slice(-300))}`,
  )
  check('the unauthed receive deadline is enforced in the reap', server.includes('UNAUTHED_DEADLINE_S'))
  check('ping answered on the socket thread (busy ≠ dead)', /op == "ping"/.test(server))
  check('the token is RE-READ per hello (rotation-safe)', server.includes('_read_token'))
  check('an oversized answer is REPLACED, id preserved (never silent truncation)', server.includes('exceeds the %d-byte frame cap'))
  const pump = file(`${MOD}/pump.py`)
  check('the pump is registered persistent=True (survives file loads — the doc sentence)', pump.includes('persistent=True'))
  check('the pump re-arms by returning the interval', pump.includes('return state.PUMP_INTERVAL_S'))
  check('a handler surprise answers INTERNAL, never a dropped request', pump.includes('"INTERNAL"'))
}

section('5. the verb mechanics live in the source')
{
  const ops = file(`${MOD}/ops.py`)
  check('the RENDER_ACTIVE gate rides is_job_running (the truth source)', ops.includes('is_job_running("RENDER")'))
  check('blend_open refuses BLEND_DIRTY naming the save road', ops.includes('BLEND_DIRTY') && /File > Save/.test(ops))
  check('blend_open refuses BLEND_NOT_FOUND', ops.includes('BLEND_NOT_FOUND'))
  check('render_still runs as a JOB (INVOKE_DEFAULT + write_still)', ops.includes(`"INVOKE_DEFAULT", write_still=True`))
  check('render_still restores the scene’s own output settings', ops.includes('prev_filepath') && ops.includes('prev_frame'))
  const bridge = bridgeUnderPython()
  check(
    'the finish handlers guard renders the bridge did not start',
    bridge.probe.eventsNotOurs?.length === 0 && bridge.probe.reportsNotOurs === 0 && bridge.probe.eventsOurs?.join() === 'render_finished' && bridge.probe.activeAfter === false,
    `under ${bridge.ran}: both finish handlers called with a render that is not the bridge's emit ${JSON.stringify(bridge.probe.eventsNotOurs ?? bridge.said.slice(-300))} and report ${bridge.probe.reportsNotOurs ?? '?'} line(s); with a render of the bridge's they emit ${JSON.stringify(bridge.probe.eventsOurs ?? [])}`,
  )
  check('render_finished ok is the FILE truth (isfile at completion)', ops.includes('os.path.isfile(job["outputPath"])'))
  check('python_run enforces the source cap as BAD_ARGS', ops.includes('PYTHON_SOURCE_CAP_BYTES'))
  check('python_run answers PYTHON_EXCEPTION with a bounded traceback tail', ops.includes('PYTHON_EXCEPTION') && ops.includes('traceback (tail):'))
  check('python_run CONSUMES `result` (popped — no stale leak)', ops.includes('state.python_namespace.pop("result")'))
  check('python_run redirects stdout/stderr for the run only', ops.includes('redirect_stdout') && ops.includes('redirect_stderr'))
  check('@persistent on the lifecycle handlers (they survive loads)', (ops.match(/@persistent/g) ?? []).length >= 4)
  check('load_post updates the snapshot AND emits blend_changed', ops.includes('_on_load_post') && ops.includes('"blend_changed"'))
  const ring = file(`${MOD}/ring.py`)
  check('the ring counts evictions honestly', ring.includes('_dropped += 1'))
  check(
    'the logging handler tolerates any thread and never raises',
    bridge.probe.emitWithAppendRaising === 'returned' && bridge.probe.emitAppends === 1,
    `under ${bridge.ran}: emit with the ring refusing ${bridge.probe.emitWithAppendRaising ?? bridge.said.slice(-300)}; emit with the ring open appends ${bridge.probe.emitAppends ?? '?'} line(s)`,
  )
}

section('6. nothing dials out or spawns')
{
  const allPy = BLENDER_BRIDGE_FILES.filter(f => f.path.endsWith('.py')).map(f => f.content).join('\n')
  check('no outbound connects (the server only accepts)', !allPy.includes('.connect(') && !allPy.includes('create_connection'))
  check('no subprocess/os.system surface', !allPy.includes('subprocess') && !allPy.includes('os.system'))
  check('no urllib/http surface', !allPy.includes('urllib') && !allPy.includes('http.client'))
}

console.log('\n' + (failures === 0 ? '✅ blender-bridge package proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
