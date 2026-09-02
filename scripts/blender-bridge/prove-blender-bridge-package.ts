#!/usr/bin/env bun
// ============================================================================
//  scripts/blender-bridge/prove-blender-bridge-package.ts
//  PROOF: the baked Python add-on is structurally whole — bl_info lawful,
//  every source file present, the contract constants EQUAL to the
//  TypeScript module's (one truth, two languages), and the load-bearing
//  mechanics IN the source (the stdlib-only socket thread, the persistent
//  pump, the @persistent lifecycle handlers, accept-newest at hello, the
//  unauthed deadline, the RENDER_ACTIVE guard, the python_run caps and
//  honest exception road, the not-ours render guard). These are STRUCTURAL
//  pins over the shipped source — the add-on never runs in-lane (that
//  proof is the written Mac drill); they hold the source to the contract
//  the fake bridge implements.
// ============================================================================

import {
  BLENDER_BRIDGE_DIGEST,
  BLENDER_BRIDGE_FILES,
} from '../../src/services/blender/bridgeFiles.generated.js'
import {
  BLENDER_BRIDGE_PROTOCOL_VERSION,
  BLENDER_BRIDGE_DEFAULT_PORT,
  BLENDER_BRIDGE_MAX_LINE_BYTES,
  BLENDER_BRIDGE_OBJECTS_NODE_CAP,
  BLENDER_BRIDGE_REPORT_RING_CAP,
  BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES,
  BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES,
  blenderBridgeVerbNames,
} from '../../src/services/blender/bridgeProtocol.js'

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
  check('accept-newest fires at HELLO time (probe-immune)', server.includes('ACCEPT-NEWEST AT HELLO TIME'))
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
  check('the finish handlers guard renders the bridge did not start', ops.includes('not ours'))
  check('render_finished ok is the FILE truth (isfile at completion)', ops.includes('os.path.isfile(job["outputPath"])'))
  check('python_run enforces the source cap as BAD_ARGS', ops.includes('PYTHON_SOURCE_CAP_BYTES'))
  check('python_run answers PYTHON_EXCEPTION with a bounded traceback tail', ops.includes('PYTHON_EXCEPTION') && ops.includes('traceback (tail):'))
  check('python_run CONSUMES `result` (popped — no stale leak)', ops.includes('state.python_namespace.pop("result")'))
  check('python_run redirects stdout/stderr for the run only', ops.includes('redirect_stdout') && ops.includes('redirect_stderr'))
  check('@persistent on the lifecycle handlers (they survive loads)', (ops.match(/@persistent/g) ?? []).length >= 4)
  check('load_post updates the snapshot AND emits blend_changed', ops.includes('_on_load_post') && ops.includes('"blend_changed"'))
  const ring = file(`${MOD}/ring.py`)
  check('the ring counts evictions honestly', ring.includes('_dropped += 1'))
  check('the logging handler tolerates any thread and never raises', ring.includes('never raise') || ring.includes('must never raise'))
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
