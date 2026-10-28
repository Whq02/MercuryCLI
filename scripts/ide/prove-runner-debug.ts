#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'runner-debug-home-'))
process.env.MERCURY_BARE = '1'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const JS_DEBUG = path.join(ROOT, 'dist', 'vendor', 'js-debug', 'src', 'dapDebugServer.js')

const plans = await import('../../src/services/ide/testDebugPlans.ts')
const runners = await import('../../src/services/ide/projectRunners.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — runner debug proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const scratch = (label: string): string => mkdtempSync(path.join(tmpdir(), `runner-debug-${label}-`))
const ctx = { getAppState: () => ({}) } as never

const VITEST_TEST = [
  "import { describe, it, expect } from 'vitest'",
  '',
  'function add(a, b) { return a - b }',
  '',
  "describe('calc', () => {",
  "  it('adds two numbers', () => {",
  '    const result = add(2, 3)',
  '    expect(result).toBe(5)',
  '  })',
  "  it('keeps zero (0+0)', () => { expect(add(0, 0)).toBe(0) })",
  '  it(',
  "    'spans lines',",
  '    () => {',
  '      expect(1).toBe(1)',
  '    },',
  '  )',
  '})',
  '',
].join('\n')

function nodeProject(runner: 'vitest' | 'jest', withModules: boolean, parent = tmpdir()): string {
  const root = mkdtempSync(path.join(parent, `runner-debug-${runner}-`))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module', devDependencies: { [runner]: '*' } }) + '\n')
  writeFileSync(path.join(root, 'bun.lock'), '{}\n')
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'src', runner === 'vitest' ? 'calc.test.mjs' : 'calc.test.js'), VITEST_TEST)
  if (withModules) {
    const pkgDir = path.join(root, 'node_modules', runner)
    mkdirSync(pkgDir, { recursive: true })
    mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
    const entry = runner === 'vitest' ? 'vitest.mjs' : 'bin/jest.js'
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: runner, version: '0.0.0-fixture', bin: { [runner]: entry } }) + '\n')
    mkdirSync(path.dirname(path.join(pkgDir, entry)), { recursive: true })
    writeFileSync(path.join(pkgDir, entry), '#!/usr/bin/env node\nprocess.exit(0)\n')
    const link = path.join(root, 'node_modules', '.bin', runner)
    writeFileSync(link, '#!/usr/bin/env node\nprocess.exit(0)\n')
    chmodSync(link, 0o755)
  }
  return root
}

section('A. the vitest shim: the runner\'s own entry under js-debug, one test by anchored name, the stop on the test\'s first line')
{
  const root = nodeProject('vitest', true)
  const shim = plans.buildNodeRunnerDebugShim('vitest', 'src/calc.test.mjs::calc adds two numbers', { from: root })
  check('A1 program is node_modules/vitest/vitest.mjs (the package\'s own bin, never the .bin shell link)', !('state' in shim) && shim.program === path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), JSON.stringify(shim))
  check('A2 args: run <file> -t ^name$ --no-file-parallelism --test-timeout=0 (vitest\'s own debugging flags)', !('state' in shim) && JSON.stringify(shim.args) === JSON.stringify(['run', 'src/calc.test.mjs', '-t', '^calc(?: > | )adds two numbers$', '--no-file-parallelism', '--test-timeout=0']), 'state' in shim ? shim.reason : JSON.stringify(shim.args))
  check('A3 cwd is the runner root and the stop is the first line of the test body (line 7)', !('state' in shim) && shim.cwd === root && shim.stop?.file === path.join(root, 'src', 'calc.test.mjs') && shim.stop.line === 7, 'state' in shim ? shim.reason : JSON.stringify(shim.stop))
  const meta = plans.buildNodeRunnerDebugShim('vitest', 'src/calc.test.mjs::calc keeps zero (0+0)', { from: root })
  check('A4 regex metacharacters in the name are escaped inside the anchors; a one-line test stops on its own line (10)', !('state' in meta) && meta.args[3] === '^calc(?: > | )keeps zero \\(0\\+0\\)$' && meta.stop?.line === 10, 'state' in meta ? meta.reason : JSON.stringify({ t: meta.args[3], stop: meta.stop }))
  const spans = plans.buildNodeRunnerDebugShim('vitest', 'src/calc.test.mjs::calc spans lines', { from: root })
  check('A5 a title on its own line is found through the quoted-name fallback and the stop is the body\'s first line past the opening brace (14)', !('state' in spans) && spans.stop?.line === 14, 'state' in spans ? spans.reason : JSON.stringify(spans.stop))
  const unknown = plans.buildNodeRunnerDebugShim('vitest', 'src/calc.test.mjs::calc nowhere', { from: root })
  check('A6 a name the file does not carry still builds the shim with NO stop and a note that names the Debug tool', !('state' in unknown) && unknown.stop === null && unknown.note.includes('Debug tool') && unknown.args[3] === '^calc nowhere$', JSON.stringify(unknown))
  const missing = plans.buildNodeRunnerDebugShim('vitest', 'src/absent.test.mjs::x', { from: root })
  check('A7 a missing test file refuses typed', 'state' in missing && missing.state === 'unavailable' && missing.reason.includes('not found'), JSON.stringify(missing))
  const bare = runWithCwdOverride(root, () => plans.buildNodeRunnerDebugShim('vitest', 'calc adds two numbers', { from: root }))
  check('A8 a bare name with no run record refuses with the file::name remedy', 'state' in bare && bare.remedy.includes('file::name'), JSON.stringify(bare))
  rmSync(root, { recursive: true, force: true })
}

section('B. the jest shim')
{
  const root = nodeProject('jest', true)
  const shim = plans.buildNodeRunnerDebugShim('jest', 'src/calc.test.js::calc adds two numbers', { from: root })
  check('B1 program is node_modules/jest/bin/jest.js and args are --runInBand <file> -t ^name$ (jest\'s own debugging shape)', !('state' in shim) && shim.program === path.join(root, 'node_modules', 'jest', 'bin', 'jest.js') && JSON.stringify(shim.args) === JSON.stringify(['--runInBand', 'src/calc.test.js', '-t', '^calc adds two numbers$']), JSON.stringify(shim))
  check('B2 the stop is the first line of the test body', !('state' in shim) && shim.stop?.line === 7, 'state' in shim ? shim.reason : JSON.stringify(shim.stop))
  rmSync(root, { recursive: true, force: true })
}

section('C. a bare name is placed by the latest run\'s case rows (the reporter carries the file)')
{
  const parent = scratch('python-marker')
  writeFileSync(path.join(parent, 'requirements.txt'), '')
  const root = nodeProject('vitest', true, parent)
  const report = readFileSync(path.join(import.meta.dir, 'fixtures', 'runners', 'vitest-report.json'), 'utf8').split('/work/project').join(root)
  const bin = path.join(root, 'node_modules', '.bin', 'vitest')
  writeFileSync(bin, ['#!/usr/bin/env node', `const out = process.argv.slice(2).find(a => a.startsWith('--outputFile='))`, `if (out) require('fs').writeFileSync(out.slice('--outputFile='.length), ${JSON.stringify(report)})`, 'process.exit(1)', ''].join('\n'))
  chmodSync(bin, 0o755)
  const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'vitest' && p.kind === 'test')!
  const run = await runners.runRunnerProfile(profile, { from: root })
  check('C1 the run recorded the failing case with its file', run.state === 'ok' && run.record.cases.some(c => c.id === 'calc adds two numbers' && c.file === 'src/calc.test.mjs'), JSON.stringify(run.state === 'ok' ? run.record.cases : run))
  const shim = runWithCwdOverride(root, () => plans.buildNodeRunnerDebugShim('vitest', 'calc adds two numbers', { from: root }))
  check('C2 the bare full name resolves below a Python marker', !('state' in shim) && shim.stop?.file === path.join(root, 'src', 'calc.test.mjs') && shim.stop.line === 7 && shim.args[1] === 'src/calc.test.mjs', JSON.stringify(shim))
  const nodeRoot = path.join(parent, 'node-package')
  mkdirSync(path.join(nodeRoot, 'test'), { recursive: true })
  writeFileSync(path.join(nodeRoot, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}')
  const testFile = path.join(nodeRoot, 'test', 'invoice.test.mjs')
  writeFileSync(testFile, "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('invoice', () => assert.equal(453.5, 107));\n")
  const nodeProfile = runners.discoverRunnerProfiles(nodeRoot).profiles.find(p => p.runner === 'node-test')!
  const nodeRun = await runners.runRunnerProfile(nodeProfile, { from: nodeRoot })
  check('C3 node-test writes the failed case at its own package root', nodeRun.state === 'ok' && nodeRun.record.cases.some(c => c.id === 'invoice' && c.file === 'test/invoice.test.mjs'), JSON.stringify(nodeRun))
  const { findPythonProjectRoot } = await import('../../src/services/ide/pythonProject.ts')
  check('C4 the Python and runner roots really differ', findPythonProjectRoot(nodeRoot).root === parent && runners.findRunnerRoot(nodeRoot) === nodeRoot)
  for (const from of [nodeRoot, path.join(nodeRoot, 'test')]) {
    const nodeShim = runWithCwdOverride(from, () => runners.buildNodeTestDebugShim('invoice', { from }))
    check('C5 a node-test bare name resolves from the package and its subdirectory', !('state' in nodeShim) && nodeShim.program === testFile && nodeShim.cwd === nodeRoot, JSON.stringify(nodeShim))
  }
  rmSync(parent, { recursive: true, force: true })
}

section('D. the Test tool: vitest and jest debug ride js-debug; an absent runner is an honest unavailable with its remedy')
{
  const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
  const toolSrc = readFileSync(path.join(ROOT, 'src/tools/TestTool/TestTool.ts'), 'utf8')
  check('D1 the debug op routes vitest and jest through the node-runner shim onto adapterKey js with the shim\'s program and args', toolSrc.includes("buildNodeRunnerDebugShim(runner, input.node") && toolSrc.includes("launchRunnerDebug({ runner, adapterKey: 'js', program: shim.program, args: shim.args") && toolSrc.includes('breakpoints.set(plan.stop.file, [plan.stop])'))
  const root = nodeProject('vitest', false)
  const out = (await runWithCwdOverride(root, () => TestTool.call({ op: 'debug', node: 'src/calc.test.mjs::calc adds two numbers' } as never, ctx))) as { data: { result: string; outcome: string } }
  check('D2 vitest declared but not installed: "debug unavailable" with the install remedy, never a sentence about the debugger not being there', out.data.outcome === 'failed' && out.data.result.startsWith('debug unavailable: vitest is declared but node_modules/.bin/vitest is missing') && out.data.result.includes('remedy: install the project dependencies'), out.data.result)
  rmSync(root, { recursive: true, force: true })
}

const JEST_TEST = VITEST_TEST.split('\n').slice(1).join('\n')

async function liveNodeRunner(tag: string, runner: 'vitest' | 'jest', entry: string, testFile: string, source: string, packageJson: Record<string, unknown>): Promise<void> {
  section(`${tag}. the live leg — a real ${runner} under the vendored js-debug stops on the test's first line with locals readable`)
  const modules = process.env.MERCURY_PROOF_RUNNER_MODULES
  const runnerEntry = modules ? path.join(modules, runner, entry) : ''
  if (!modules || !existsSync(runnerEntry)) {
    console.log(`  [SKIP — LOUD] no ${runner} on this machine (${modules ? `${runnerEntry} absent` : 'MERCURY_PROOF_RUNNER_MODULES unset'}) — the shim and the tool route above are the evidence`)
    return
  }
  if (!existsSync(JS_DEBUG)) {
    console.log(`  [SKIP — LOUD] ${JS_DEBUG} absent — build the tree (bun run build.ts) for the vendored js-debug`)
    failures++
    return
  }
  process.env.MERCURY_JS_DEBUG_DAP = JS_DEBUG
  const root = scratch(`live-${runner}`)
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'live', private: true, devDependencies: { [runner]: '*' }, ...packageJson }) + '\n')
  writeFileSync(path.join(root, 'bun.lock'), '{}\n')
  symlinkSync(modules, path.join(root, 'node_modules'))
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'src', testFile), source)
  const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
  const dap = await import('../../src/services/dap/dapClient.ts')
  const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
  const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')
  await runWithCwdOverride(root, () => TestTool.call({ op: 'run', framework: runner } as never, ctx))
  const plain = spawnSync('node', [path.join(root, 'node_modules', runner, entry), ...(runner === 'vitest' ? ['run', `src/${testFile}`] : ['--runInBand', `src/${testFile}`])], { windowsHide: true, cwd: root, encoding: 'utf8' })
  check(`${tag}0 the debug fixture runs outside the debugger`, plain.status === 1 && /adds two numbers/.test(plain.stdout + plain.stderr), JSON.stringify({ code: plain.status, output: plain.stdout + plain.stderr }))
  const bodyLine = source.split('\n').findIndex(l => l.includes('const result = add(2, 3)')) + 1
  const out = (await runWithCwdOverride(root, () => TestTool.call({ op: 'debug', node: `src/${testFile}::adds two numbers` } as never, ctx))) as { data: { result: string; outcome: string } }
  check(`${tag}1 the tool reports a stop at a breakpoint`, out.data.outcome === 'succeeded' && /stopped in '.*' — reason breakpoint/.test(out.data.result), out.data.result.split('\n').slice(0, 3).join(' | '))
  const owner = ownerFromToolUseContext(ctx)
  const session = dap.getDapSession(owner, 'test')
  const stopped = session?.treeStopped() ?? null
  check(`${tag}2 a session named test is live and a tree member holds the stop`, session !== undefined && stopped !== null, JSON.stringify({ sessions: session?.treeSessions().map(s => s.label), output: session?.output }))
  if (session && stopped && stopped.lastStopped) {
    const threadId = stopped.lastStopped.threadId ?? 1
    const stack = await stopped.request('stackTrace', { threadId, startFrame: 0, levels: 3 })
    const frames = stack.stackFrames as Array<{ id: number; name?: string; line?: number; source?: { path?: string } }>
    check(`${tag}3 the top frame is the test body in the REAL test file at its first line (${bodyLine})`, (frames[0]?.source?.path ?? '').endsWith(`src/${testFile}`) && frames[0]?.line === bodyLine, JSON.stringify(frames[0]))
    const stamp = session.treeNewestStopStamp()
    await stopped.request('next', { threadId })
    const stepped = await session.waitForStopOutcome(10_000, undefined, stamp)
    const frame = stepped.state === 'stopped' ? ((await stepped.session.request('stackTrace', { threadId: stepped.info.threadId ?? threadId, startFrame: 0, levels: 1 })).stackFrames as Array<{ id: number; line?: number }>)[0] : undefined
    check(`${tag}4 one step lands on the next line of the test (${bodyLine + 1})`, stepped.state === 'stopped' && frame?.line === bodyLine + 1, JSON.stringify(stepped.state === 'stopped' ? frame : stepped))
    if (stepped.state === 'stopped' && frame) {
      const scopes = await stepped.session.request('scopes', { frameId: frame.id })
      const rows = scopes.scopes as Array<{ name: string; variablesReference: number }>
      const seen: Array<{ scope: string; name: string; value: string }> = []
      for (const scope of rows.slice(0, 3)) {
        const vars = await stepped.session.request('variables', { variablesReference: scope.variablesReference })
        for (const v of vars.variables as Array<{ name: string; value: string }>) seen.push({ scope: scope.name, name: v.name, value: v.value })
      }
      const result = seen.find(v => v.name === 'result')
      check(`${tag}5 locals are readable: result reads -1 (the defect the test catches)`, result?.value === '-1', JSON.stringify(seen.slice(0, 8)))
    }
  }
  await disposeOwner(owner)
  check(`${tag}6 disconnect is clean: no session left`, dap._dapSessionCountForTesting() === 0, String(dap._dapSessionCountForTesting()))
  delete process.env.MERCURY_JS_DEBUG_DAP
  rmSync(root, { recursive: true, force: true })
}

await liveNodeRunner('E', 'vitest', 'vitest.mjs', 'calc.test.mjs', VITEST_TEST, { type: 'module' })
await liveNodeRunner('F', 'jest', 'bin/jest.js', 'calc.test.js', JEST_TEST, { jest: { testEnvironment: 'node' } })

const GO_TEST = [
  'package calc',
  '',
  'import "testing"',
  '',
  'func TestAdd(t *testing.T) {',
  '\tif got := Add(2, 3); got != 5 {',
  '\t\tt.Errorf("add(2, 3) = %d, want 5", got)',
  '\t}',
  '}',
  '',
  'func TestTable(t *testing.T) {',
  '\tt.Run("one", func(t *testing.T) {})',
  '\tt.Run("two", func(t *testing.T) { t.Fatal("case two") })',
  '}',
  '',
  'func TestZero(t *testing.T) {}',
  '',
].join('\n')

function goModule(): string {
  const root = scratch('go')
  writeFileSync(path.join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n')
  writeFileSync(path.join(root, 'calc.go'), 'package calc\n\nfunc Add(a, b int) int { return a - b }\n')
  writeFileSync(path.join(root, 'calc_test.go'), GO_TEST)
  mkdirSync(path.join(root, 'other'))
  writeFileSync(path.join(root, 'other', 'other_test.go'), 'package other\n\nimport "testing"\n\nfunc TestZero(t *testing.T) {}\n')
  return root
}

function standInBinaries(root: string, names: string[]): string {
  const binDir = path.join(root, `stand-in-bin-${names.join('-')}`)
  mkdirSync(binDir, { recursive: true })
  for (const name of names) {
    writeFileSync(path.join(binDir, name), '#!/usr/bin/env node\nprocess.exit(0)\n')
    chmodSync(path.join(binDir, name), 0o755)
  }
  return binDir
}

section('G. the go plan: dlv builds the package\'s test binary, one test by anchored -test.run, the stop on the func line')
{
  const root = goModule()
  const savedPath = process.env.PATH
  process.env.PATH = `${standInBinaries(root, ['go', 'dlv'])}${path.delimiter}${savedPath ?? ''}`
  try {
    const plan = plans.buildGoTestDebugPlan('TestAdd', { from: root })
    check('G1 program is the package directory, args -test.run ^TestAdd$ -test.v, cwd the module root, launch extra mode: test', !('state' in plan) && plan.program === root && JSON.stringify(plan.args) === JSON.stringify(['-test.run', '^TestAdd$', '-test.v']) && plan.cwd === root && plan.launchExtras.mode === 'test', JSON.stringify(plan))
    check('G2 the stop is the func TestAdd line (5) in calc_test.go', !('state' in plan) && plan.stop.file === path.join(root, 'calc_test.go') && plan.stop.line === 5, 'state' in plan ? plan.reason : JSON.stringify(plan.stop))
    const sub = plans.buildGoTestDebugPlan('TestTable/two', { from: root })
    check('G3 a subtest anchors each level (^TestTable$/^two$) and stops on the parent func line (11)', !('state' in sub) && sub.args[1] === '^TestTable$/^two$' && sub.stop.line === 11, 'state' in sub ? sub.reason : JSON.stringify({ args: sub.args, stop: sub.stop }))
    const twice = plans.buildGoTestDebugPlan('TestZero', { from: root })
    check('G4 a name declared in two packages refuses naming them and the dir::TestName remedy', 'state' in twice && twice.reason.includes('2 packages') && twice.reason.includes('other') && twice.remedy.includes('dir::TestName'), JSON.stringify(twice))
    const picked = plans.buildGoTestDebugPlan('other::TestZero', { from: root })
    check('G5 dir::TestName picks the package: program root/other, stop other/other_test.go:5', !('state' in picked) && picked.program === path.join(root, 'other') && picked.stop.file === path.join(root, 'other', 'other_test.go') && picked.stop.line === 5, JSON.stringify(picked))
    const nowhere = plans.buildGoTestDebugPlan('TestNowhere', { from: root })
    check('G6 an unknown test refuses typed', 'state' in nowhere && nowhere.reason.includes('no func TestNowhere'), JSON.stringify(nowhere))
    const notATest = plans.buildGoTestDebugPlan('calc.go', { from: root })
    check('G7 a node that is not a Go test name refuses with the three spellings', 'state' in notATest && notATest.remedy.includes('TestName/subtest'), JSON.stringify(notATest))
  } finally {
    process.env.PATH = savedPath
  }
  process.env.PATH = `${standInBinaries(root, ['go'])}${path.delimiter}${savedPath ?? ''}`
  try {
    const noDlv = plans.buildGoTestDebugPlan('TestAdd', { from: root })
    check('G8 go present, dlv absent: unavailable with the delve install line', 'state' in noDlv && noDlv.reason.includes("'dlv' not on PATH") && noDlv.remedy === plans.DLV_INSTALL_REMEDY, JSON.stringify(noDlv))
    const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
    const out = (await runWithCwdOverride(root, () => TestTool.call({ op: 'debug', node: 'TestAdd' } as never, ctx))) as { data: { result: string; outcome: string } }
    const firstLine = out.data.result.split('\n')[0] ?? ''
    check('G9 the Test tool names the missing Go debugger with the delve install line in one line, runs the test without a stop, and follows with the run\'s own words', firstLine === `no Go debugger (dlv) on this machine — ${plans.DLV_INSTALL_REMEDY}; the test ran without a stop` && /go test -json -run TestAdd/.test(out.data.result), out.data.result)
  } finally {
    process.env.PATH = savedPath
  }
  const emptyBin = path.join(root, 'empty-bin')
  mkdirSync(emptyBin)
  process.env.PATH = emptyBin
  try {
    const noGo = plans.buildGoTestDebugPlan('TestAdd', { from: root })
    check('G10 no go toolchain: unavailable naming the toolchain and the delve line', 'state' in noGo && noGo.reason.includes("'go' not on PATH") && noGo.remedy.includes('Go toolchain') && noGo.remedy.includes(plans.DLV_INSTALL_REMEDY), JSON.stringify(noGo))
  } finally {
    process.env.PATH = savedPath
  }
  const toolSrc = readFileSync(path.join(ROOT, 'src/tools/TestTool/TestTool.ts'), 'utf8')
  check('G11 the Test tool routes go through the plan onto adapterKey go with mode: test as a launch extra', toolSrc.includes('buildGoTestDebugPlan(input.node') && toolSrc.includes("adapterKey: 'go'") && toolSrc.includes('launchExtras: plan.launchExtras'))
  rmSync(root, { recursive: true, force: true })
}

section('H. the live go leg — a real go and dlv on PATH')
{
  const have = (name: string): boolean => (process.env.PATH ?? '').split(path.delimiter).some(d => d && existsSync(path.join(d, name)))
  if (!have('go') || !have('dlv')) {
    console.log(`  [SKIP — LOUD] ${!have('go') ? 'go' : 'dlv'} is not on PATH — the plan and the unavailable answers above are the evidence; install the Go toolchain and delve (${plans.DLV_INSTALL_REMEDY}) to run this leg`)
  } else {
    const root = goModule()
    const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
    const dap = await import('../../src/services/dap/dapClient.ts')
    const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
    const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')
    const out = (await runWithCwdOverride(root, () => TestTool.call({ op: 'debug', node: 'TestAdd' } as never, ctx))) as { data: { result: string; outcome: string } }
    check('H1 the tool reports a stop at a breakpoint under dlv', out.data.outcome === 'succeeded' && /reason breakpoint/.test(out.data.result), out.data.result.split('\n').slice(0, 3).join(' | '))
    const owner = ownerFromToolUseContext(ctx)
    const session = dap.getDapSession(owner, 'test')
    const stopped = session?.treeStopped() ?? null
    if (stopped && stopped.lastStopped) {
      const threadId = stopped.lastStopped.threadId ?? 1
      const stack = await stopped.request('stackTrace', { threadId, startFrame: 0, levels: 1 })
      const frame = (stack.stackFrames as Array<{ id: number; name?: string; line?: number; source?: { path?: string } }>)[0]
      check('H2 the top frame is TestAdd in calc_test.go at its first line (5 or the first statement, 6)', (frame?.source?.path ?? '').endsWith('calc_test.go') && (frame?.line === 5 || frame?.line === 6) && (frame?.name ?? '').includes('TestAdd'), JSON.stringify(frame))
      const scopes = await stopped.request('scopes', { frameId: frame!.id })
      const rows = scopes.scopes as Array<{ name: string; variablesReference: number }>
      const vars = rows.length ? await stopped.request('variables', { variablesReference: rows[0]!.variablesReference }) : { variables: [] }
      check('H3 locals are readable (the testing.T argument t)', (vars.variables as Array<{ name: string }>).some(v => v.name === 't'), JSON.stringify((vars.variables as Array<{ name: string }>).map(v => v.name)))
    }
    await disposeOwner(owner)
    check('H4 disconnect is clean', dap._dapSessionCountForTesting() === 0)
    rmSync(root, { recursive: true, force: true })
  }
}


section('I. the cargo plan — the test binary cargo built, the one that lists the test, the #[test] fn line, lldb-dap (or gdb)')
{
  const cargoBin = (process.env.PATH ?? '').split(path.delimiter).map(d => path.join(d, 'cargo')).find(p => p && existsSync(p))
  const toolSrc = readFileSync(path.join(ROOT, 'src/tools/TestTool/TestTool.ts'), 'utf8')
  check('I0 the Test tool routes cargo through the plan with the adapter the plan resolved', toolSrc.includes('buildCargoTestDebugPlan(input.node') && toolSrc.includes("runner: 'cargo', adapterKey: plan.adapterKey"))
  if (!cargoBin) {
    console.log('  [SKIP — LOUD] no cargo on PATH — the tool route above is the evidence; install the Rust toolchain (rustup) to run this leg')
  } else {
    const root = scratch('cargo')
    mkdirSync(path.join(root, 'src'))
    writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "calc"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n')
    writeFileSync(
      path.join(root, 'src', 'lib.rs'),
      [
        'pub fn two() -> i32 {',
        '    3',
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    #[test]',
        '    fn is_two() {',
        '        let got = super::two();',
        '        assert_eq!(got, 2);',
        '    }',
        '',
        '    #[test]',
        '    fn trivially() {',
        '        assert!(true);',
        '    }',
        '}',
        '',
      ].join('\n'),
    )
    const savedTarget = process.env.CARGO_TARGET_DIR
    process.env.CARGO_TARGET_DIR = path.join(root, 'target')
    const dap = await import('../../src/services/dap/dapClient.ts')
    const plan = await plans.buildCargoTestDebugPlan('tests::is_two', { from: root })
    const native = dap.resolveLldbDap() !== null ? 'lldb' : dap.probeGdbDap().viable ? 'gdb' : null
    if (native === null) {
      check('I1 with no native adapter the plan is an honest unavailable naming the install', 'state' in plan && plan.reason.includes('no native debug adapter'), JSON.stringify(plan))
    } else {
      check('I1 the plan names the test binary cargo built under the scratch target dir', !('state' in plan) && plan.program.startsWith(path.join(root, 'target')) && existsSync(plan.program), JSON.stringify(plan))
      check('I2 args: --exact tests::is_two --nocapture --test-threads=1; cwd the crate root; the adapter is the resolved native one', !('state' in plan) && JSON.stringify(plan.args) === JSON.stringify(['--exact', 'tests::is_two', '--nocapture', '--test-threads=1']) && plan.cwd === root && plan.adapterKey === native, 'state' in plan ? plan.reason : JSON.stringify({ args: plan.args, adapter: plan.adapterKey }))
      check('I3 the stop is the #[test] fn line (8) in src/lib.rs', !('state' in plan) && plan.stop?.file === path.join(root, 'src', 'lib.rs') && plan.stop.line === 8, 'state' in plan ? plan.reason : JSON.stringify(plan.stop))
      if (!('state' in plan)) {
        const { spawnSync } = await import('node:child_process')
        const listed = spawnSync(plan.program, ['--list', '--format', 'terse'], { encoding: 'utf8' }).stdout
        check('I4 the selected binary lists the test itself', listed.split('\n').some(l => l.trim() === 'tests::is_two: test'), listed.slice(0, 120))
      }
      const unknown = await plans.buildCargoTestDebugPlan('tests::nowhere', { from: root })
      check('I5 a test cargo does not list refuses naming the binaries', 'state' in unknown && unknown.reason.includes("no test named 'tests::nowhere'") && unknown.reason.includes('calc'), JSON.stringify(unknown))
      const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
      const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
      const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')
      const hint = native === 'lldb' ? dap.darwinDebuggerAuthorisationHint() : null
      const out = (await runWithCwdOverride(root, () => TestTool.call({ op: 'debug', node: 'tests::is_two' } as never, ctx))) as { data: { result: string; outcome: string } }
      const stoppedOnTest = out.data.outcome === 'succeeded' && /reason breakpoint/.test(out.data.result)
      const debuggerBlocked = out.data.outcome === 'failed' && out.data.result.includes('DevToolsSecurity -enable')
      if (debuggerBlocked) {
        console.log(`  [SKIP — LOUD] the stop leg: the native debugger blocked in task_for_pid — ${hint ?? 'the status word reads enabled, yet the launch never answered'}`)
        check('I6 when the native debugger really blocked, the user gets the honest silence line naming the one durable fix', out.data.result.includes('sudo DevToolsSecurity -enable'), out.data.result.split('\n').slice(0, 2).join(' | '))
      } else if (!stoppedOnTest) {
        check('I6 the stop leg either stopped on the test or the native debugger blocked with the honest line — neither happened', false, out.data.result.split('\n').slice(0, 3).join(' | '))
        await disposeOwner(ownerFromToolUseContext(ctx))
      } else {
        check(`I6 the authorisation is granted this boot — the stop leg is the evidence${hint !== null ? ' (the status word still reads disabled; the word is not the live fact)' : ''}`, true)
        const owner = ownerFromToolUseContext(ctx)
        const session = dap.getDapSession(owner, 'test')
        const stopped = session?.treeStopped() ?? null
        if (stopped && stopped.lastStopped) {
          const threadId = stopped.lastStopped.threadId ?? 1
          const stack = await stopped.request('stackTrace', { threadId, startFrame: 0, levels: 1 })
          const frame = (stack.stackFrames as Array<{ id: number; name?: string; line?: number; source?: { path?: string } }>)[0]
          check('I7 the top frame is the test fn in src/lib.rs on its first line (8 or 9)', (frame?.source?.path ?? '').endsWith('src/lib.rs') && (frame?.line === 8 || frame?.line === 9), JSON.stringify(frame))
          const scopes = await stopped.request('scopes', { frameId: frame!.id })
          check('I8 scopes are readable', Array.isArray(scopes.scopes) && (scopes.scopes as unknown[]).length > 0)
        }
        await disposeOwner(owner)
        check('I9 disconnect is clean', dap._dapSessionCountForTesting() === 0)
      }
    }
    if (savedTarget === undefined) delete process.env.CARGO_TARGET_DIR
    else process.env.CARGO_TARGET_DIR = savedTarget
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('')
if (failures > 0) {
  console.error(`prove-runner-debug: ${failures} RED`)
  process.exit(1)
}
console.log('prove-runner-debug: GREEN')
