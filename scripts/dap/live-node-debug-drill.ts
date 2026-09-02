#!/usr/bin/env bun
// ============================================================================
//  scripts/dap/live-node-debug-drill.ts — the Node/TypeScript debug loop on a
//  REAL box, tool-door driven (the NODEDEBUG closing leg; the drill-1
//  precedent): a real failing TS test → Test tool run (node-test lane) →
//  ONE Debug-tool gesture to a live js-debug child session → breakpoint in
//  the imported module → stack/locals/evaluate (the truth vs the bug) →
//  continue → fix → Test tool rerun GREEN.
//
//  RUN_LIVE=1 gates it (never part of the pure suite — the prove-*.ts glob
//  does not match this file). Requires: node on PATH (or NODE=<path>) and a
//  js-debug resolution (vendored bundle / MERCURY_JS_DEBUG_DAP / the
//  ~/.js-debug unpack). The adapter is pinned to NODE via an env-table row —
//  under bun, process.execPath lies for node-targeted adapters (the recorded
//  house lesson), while the deployed artifact's builtin row runs under node
//  by construction.
//
//  Run:  RUN_LIVE=1 ~/.bun/bin/bun run scripts/dap/live-node-debug-drill.ts
// ============================================================================

// The MACRO stamp MUST precede any src import that reads it.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.RUN_LIVE !== '1') {
  console.log('live-node-debug-drill: RUN_LIVE!=1 — skipped (a live drill, never suite-run).')
  process.exit(0)
}

// Hermetic home: a live drill must never write operator state.
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'node-drill-home-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { whichSync } = await import('../../src/utils/which.js')
const { resolveJsDebugServer, jsDebugSourceLabel } = await import('../../src/services/dap/dapClient.js')

console.log('============================================================')
console.log(' the Node/TS debug loop — live drill (tool-door, this box)')
console.log('============================================================')

section('0. arms (honest refusals, never a wedge)')
const nodeBin = process.env.NODE ?? whichSync('node')
if (!nodeBin) {
  console.error('  REFUSED: no node on PATH (set NODE=<path>) — the drill drives node-targeted debugging.')
  process.exit(1)
}
// The VENDORED rung in-repo is the drill's DEFAULT road: the module-class
// fence ({"type":"commonjs"}, written at the build's vendor step) makes the
// tree boot inside this type:module repo. The resolver's own vendored rung
// is artifact-relative (dist is the built artifact's home, not src's), so a
// src-run drill reaches the same bytes by path; the env pin stays the
// explicit override it always was.
const distVendored = join(import.meta.dir, '..', '..', 'dist', 'vendor', 'js-debug', 'src', 'dapDebugServer.js')
const jsDebug = resolveJsDebugServer() ?? (existsSync(distVendored) ? { path: distVendored, source: 'vendored' as const } : null)
if (!jsDebug) {
  console.error(
    '  REFUSED: no js-debug resolution — rebuild with the vendored js-debug (bun run scripts/vendor/fetch-js-debug.ts && bun run build.ts), point MERCURY_JS_DEBUG_DAP at dapDebugServer.js, or unpack js-debug-dap to ~/.js-debug.',
  )
  process.exit(1)
}
console.log(`  node: ${nodeBin}`)
console.log(`  js-debug via ${jsDebugSourceLabel(jsDebug.source)}: ${jsDebug.path}`)

// The drill's adapter row: the SAME server the ladder resolved, pinned to
// node (env rows beat builtins in resolveAdapter — the proof seam).
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
  js: {
    command: nodeBin,
    args: [jsDebug.path, '${port}', '127.0.0.1'],
    connect: 'tcp',
    fileTypes: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'],
    rootMarkers: ['package.json'],
    launchDefaults: { type: 'pwa-node' },
    attachDefaults: { type: 'pwa-node' },
    installHint: `drill row — js-debug via ${jsDebugSourceLabel(jsDebug.source)} under ${nodeBin}`,
  },
})

section('1. the scratch project: a real failing TS test')
const project = mkdtempSync(join(tmpdir(), 'node-drill-proj-'))
const mathTs = join(project, 'math.ts')
const testTs = join(project, 'math.test.ts')
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'node-drill', type: 'module' }, null, 2))
writeFileSync(
  mathTs,
  'export function compute(a: number, b: number): number {\n' +
    '  const sum = a - b\n' + // THE BUG: subtraction where addition belongs
    '  return sum\n' +
    '}\n',
)
writeFileSync(
  testTs,
  "import test from 'node:test'\n" +
    "import assert from 'node:assert/strict'\n" +
    "import { compute } from './math.ts'\n" +
    '\n' +
    "test('compute adds', () => {\n" +
    '  assert.equal(compute(2, 3), 5)\n' +
    '})\n',
)
const previousCwd = process.cwd()
process.chdir(project)
console.log(`  project: ${project}`)

const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
const { TestTool } = await import('../../src/tools/TestTool/TestTool.js')
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
// The tools read Mercury's cwd owner, not process.cwd() — the override
// context makes every call observe the scratch project.
const callDebug = async (input: Record<string, unknown>): Promise<string> =>
  ((await runWithCwdOverride(project, () => DebugTool.call(input as never, {} as never))) as {
    data: { result: string }
  }).data.result
const callTest = async (input: Record<string, unknown>): Promise<string> =>
  ((await runWithCwdOverride(project, () => TestTool.call(input as never, {} as never))) as {
    data: { result: string }
  }).data.result

try {
  section('2. Test tool: the failure is real (node-test lane)')
  const firstRun = await callTest({ op: 'run' })
  console.log(`  » ${firstRun.split('\n')[0]}`)
  check('the run FAILS before the fix', /1 failed|[1-9]\d* failed/.test(firstRun), firstRun.slice(0, 200))
  check('the node-test lane ran it', firstRun.includes('node-test'), firstRun.slice(0, 120))

  section('2b. the Test tool hand-off: op:"debug" — one gesture from the TEST surface')
  // The BARE name rides the run record's case rows (the file placed by the
  // TAP location diag); the stop lands in the js-debug child, session
  // 'test' (the Test tool's default), continued through the Debug tool.
  const handoff = await callTest({ op: 'debug', node: 'compute adds', file: mathTs, lines: [2] })
  console.log(`  » ${handoff.split('\n')[0]}`)
  check(
    "the hand-off stops IN the js-debug child (Debug session 'test')",
    /debugging compute adds \(node-test\) in Debug session 'test'/.test(handoff) && /stopped in '/.test(handoff) && handoff.includes('reason breakpoint'),
    handoff.split('\n')[0],
  )
  const hStack = await callDebug({ op: 'stack', session: 'test' })
  check('the stopped frame is compute (the breakpoint bound in the real module)', hStack.includes('compute'), hStack.split('\n')[0])
  const hDisc = await callDebug({ op: 'disconnect', session: 'test' })
  check('the hand-off session reaps clean', hDisc.includes('disconnected'), hDisc.split('\n')[0])

  section('3. ONE Debug-tool gesture: launch the test under js-debug')
  const launch = await callDebug({
    op: 'launch',
    program: testTs,
    file: mathTs,
    lines: [2],
  })
  console.log(`  » ${launch.split('\n')[0]}`)
  check('the stop lands IN a child session (the multi-session road, live)', /stopped in '/.test(launch), launch.split('\n')[0])
  check('the breakpoint stop is real', launch.includes('reason breakpoint'))
  check('the drilled line is the buggy one', /math\.ts:2/.test(launch))

  section('4. stack · locals · evaluate — the truth vs the bug')
  const stack = await callDebug({ op: 'stack' })
  check('top frame is compute', stack.includes('compute'), stack.split('\n')[0])
  const frameId = Number(stack.match(/\[frameId (\d+)\]/)?.[1])
  check('a frameId is surfaced', Number.isFinite(frameId))
  const scopes = await callDebug({ op: 'scopes', frameId })
  const localsRef = Number(scopes.match(/Local[^\[]*\[variablesReference (\d+)\]/i)?.[1])
  check('a Locals reference is surfaced', Number.isFinite(localsRef), scopes.split('\n')[0])
  const vars = await callDebug({ op: 'variables', variablesReference: localsRef })
  check('locals show a = 2 and b = 3', /a = 2/.test(vars) && /b = 3/.test(vars), vars.slice(0, 160))
  const truth = await callDebug({ op: 'evaluate', expression: 'a+b', frameId })
  check('evaluate a+b = 5 (the truth)', truth.includes('= 5'), truth)
  const bug = await callDebug({ op: 'evaluate', expression: 'a-b', frameId })
  check('evaluate a-b = -1 (the bug the debugger exposes)', bug.includes('-1'), bug)

  section('5. continue to the honest failing end, then disconnect')
  const cont = await callDebug({ op: 'continue' })
  check('the debuggee runs to termination', cont.includes('terminated'), cont.split('\n')[0])
  const disc = await callDebug({ op: 'disconnect' })
  check('the session tree is reaped', disc.includes('disconnected'))

  section('6. the fix → rerun GREEN (the loop closes)')
  writeFileSync(
    mathTs,
    'export function compute(a: number, b: number): number {\n' +
      '  const sum = a + b\n' +
      '  return sum\n' +
      '}\n',
  )
  const rerun = await callTest({ op: 'run' })
  console.log(`  » ${rerun.split('\n')[0]}`)
  check('the rerun is GREEN after the fix', /0 failed/.test(rerun) || (/passed/.test(rerun) && !/[1-9]\d* failed/.test(rerun)), rerun.slice(0, 200))
} finally {
  process.chdir(previousCwd)
  rmSync(project, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} DRILL CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ THE NODE/TS DEBUG LOOP RUNS GREEN ON THIS BOX')
process.exit(0)
