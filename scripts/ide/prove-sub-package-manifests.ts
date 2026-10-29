#!/usr/bin/env bun
// gate-watch: src/services/ide/projectRunners* src/services/ide/pythonProject* src/tools/TestTool/*
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'sub-package-manifests-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_PYTHON = process.env.MERCURY_PROOF_PYTEST_PYTHON || (process.platform === 'win32' ? 'python' : '/usr/bin/python3')
delete process.env.MERCURY_TESTS
delete process.env.MERCURY_HOME

const runners = await import('../../src/services/ide/projectRunners.ts')
const { probePytest } = await import('../../src/services/ide/pythonTests.ts')
const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
type TestRunRecord = import('../../src/services/ide/pythonTests.ts').TestRunRecord
type ToolAnswer = { data: { outcome: string; result: string; record?: TestRunRecord }; effect: { outcome: string } }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — sub-package-manifests proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

const scratch = mkdtempSync(path.join(tmpdir(), 'sub-package-manifests-'))
const call = (root: string, input: Record<string, unknown>): Promise<ToolAnswer> =>
  runWithCwdOverride(root, () => TestTool.call(input as never, { getAppState: () => ({}) } as never)) as Promise<ToolAnswer>
const ask = (root: string, input: Record<string, unknown>): Promise<{ behavior: string; message?: string }> =>
  runWithCwdOverride(root, () => TestTool.checkPermissions(input as never, {} as never)) as Promise<{ behavior: string; message?: string }>

function barePackage(root: string, name: string): void {
  mkdirSync(path.join(root, name), { recursive: true })
  writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name, private: true }) + '\n')
}
function nodeTestPackage(root: string, name: string, wrong = false): void {
  mkdirSync(path.join(root, name, 'test'), { recursive: true })
  writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name, private: true, scripts: { test: 'node --test' } }) + '\n')
  writeFileSync(path.join(root, name, 'test', 'calc.test.mjs'), `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('adds', () => { assert.equal(1 + 1, ${wrong ? 3 : 2}) })\n`)
}
function vitestPackage(root: string, name: string): void {
  mkdirSync(path.join(root, name), { recursive: true })
  writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name, private: true, devDependencies: { vitest: '^3.0.0' } }) + '\n')
}

section('A. the box\'s shape (F37W-7B-18): no manifest at the root, package.json in package1/ and package2/ (both bare), package1/test_x.py — the packages are named, the python lane never runs 0 tests at the root (RED on the base: "unittest no test ran — Ran 0 tests", exit 0); the bare file\'s run inside package1 is read on the arm the pinned interpreter is on (pytest importable → the pytest lane · absent → the zero-run words)')
{
  const root = mkdtempSync(path.join(scratch, '7b1-amb-'))
  barePackage(root, 'package1')
  barePackage(root, 'package2')
  writeFileSync(path.join(root, 'package1', 'test_x.py'), 'def test_x():\n    assert True\n')
  const probe = probePytest(path.join(root, 'package1'))
  console.log(`  arm: ${probe.detail}`)
  const lane = runners.resolveTestLane(root)
  check('A1 the lane names the sub-packages', lane.lane === 'sub-packages' && lane.lane === 'sub-packages' && lane.packages.map(p => p.dir).join(',') === 'package1,package2', JSON.stringify(lane))
  const words = 'this project declares its manifests one level down — package1/ (package.json, no test runner declared), package2/ (package.json, no test runner declared) — pass framework: to pick one, or run from the package'
  const run = await call(root, { op: 'run' })
  check('A2 run names the packages and the two remedies, runs nothing', run.data.result === words && run.data.outcome === 'no-change' && run.data.record === undefined, `${run.data.outcome} | ${run.data.result}`)
  const discover = await call(root, { op: 'discover' })
  check('A3 discover says the same', discover.data.result === words && discover.data.outcome === 'no-change', discover.data.result)
  const vitest = await call(root, { op: 'run', framework: 'vitest' })
  check('A4 framework:vitest says no manifest declares it and names what the packages do declare', vitest.data.result === 'no vitest test profile in this project\'s manifests — one level down: package1/ (package.json, no test runner declared), package2/ (package.json, no test runner declared)' && vitest.data.outcome === 'failed', vitest.data.result)
  const debug = await call(root, { op: 'debug', node: 'x' })
  check('A5 debug names the packages too', debug.data.result === words && debug.data.outcome === 'no-change', debug.data.result)
  const permission = await ask(root, { op: 'run' })
  check('A6 the permission ask does not claim the python lane', permission.behavior === 'passthrough' && (permission.message ?? '').includes('no single test runner at this root') && !(permission.message ?? '').includes('python lane'), permission.message ?? '')
  const inside = await call(path.join(root, 'package1'), { op: 'run' })
  if (probe.available) {
    check('A7 run from the package, pytest importable: its manifest declares no runner, so the python lane reads the bare test_x.py under pytest — 1 passed, outcome succeeded, no zero-run words', inside.data.record?.framework === 'pytest' && inside.data.record?.verdict === undefined && inside.data.record?.counts.passed === 1 && inside.data.outcome === 'succeeded' && inside.data.result.includes('pytest all — 1 passed · 0 failed') && !inside.data.result.includes('ran 0'), inside.data.result)
  } else {
    check('A7 run from the package, pytest absent: its manifest declares no runner, so the python lane reads test_x.py — a zero-run that names the file (row 06\'s law), never a silent 0/0/0/0', inside.data.record?.verdict === 'zero-run' && inside.data.outcome === 'failed' && inside.data.result.includes('1 test file(s) found (test_x.py), the unittest lane ran 0'), inside.data.result)
  }
  const reportAtRoot = await call(root, { op: 'report' })
  check('A8 report at the root finds the python record package1\'s run left one level down, and says where it ran', reportAtRoot.data.record?.id === inside.data.record?.id && reportAtRoot.data.result.split('\n')[0]!.endsWith(' (in package1/)'), reportAtRoot.data.result)
  writeFileSync(path.join(root, 'package2', 'test_x.py'), 'import unittest\n\nclass TestX(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n\n    def test_wrong(self):\n        self.assertEqual(1, 2)\n')
  const insideAgain = await call(path.join(root, 'package2'), { op: 'run' })
  check('A9 a TestCase file inside package2 runs there in the unittest lane on both arms (a TestCase file is never pytest evidence; a fresh folder, so no earlier profile of the folder is read): 1 passed · 1 failed', insideAgain.data.record?.framework === 'unittest' && insideAgain.data.record?.counts.passed === 1 && insideAgain.data.record?.counts.failed === 1 && insideAgain.data.record?.cwd === path.join(root, 'package2') && insideAgain.data.result.includes('unittest all — 1 passed · 1 failed'), insideAgain.data.result)
  const rerunAtRoot = await call(root, { op: 'rerunFailed' })
  check('A9 rerunFailed at the root reruns the NEWEST python record\'s one failure one level down — package2\'s, over package1\'s older record (the record report finds, rerunFailed finds too)', rerunAtRoot.data.record?.selection === 'rerun-failed' && rerunAtRoot.data.record?.counts.failed === 1 && rerunAtRoot.data.record?.cwd === path.join(root, 'package2') && rerunAtRoot.data.result.split('\n')[0]!.endsWith(' (in package2/)'), rerunAtRoot.data.result)
  rmSync(root, { recursive: true, force: true })
}

section('B. one sub-package declares one runner — the call routes there (its folder is the run\'s cwd), a python file inside it never outranks its manifest, a python file at the root level still takes the python lane, and report/rerunFailed at the root see the routed record')
{
  const root = mkdtempSync(path.join(scratch, 'one-'))
  nodeTestPackage(root, 'app', true)
  writeFileSync(path.join(root, 'README.md'), '# one package below\n')
  const lane = runners.resolveTestLane(root)
  check('B1 the lane is the sub-package\'s node --test profile', lane.lane === 'runner' && lane.lane === 'runner' && lane.profile.runner === 'node-test' && lane.profile.root === path.join(root, 'app'), JSON.stringify(lane).slice(0, 300))
  const discover = await call(root, { op: 'discover' })
  const dl = discover.data.result.split('\n')
  check('B1 discover at the root says what run does: the package\'s profiles, each marked with its folder', dl[0] === 'runner profiles (one level down, in app/):' && dl.length === 2 && /^rp-[0-9a-f]{12} \[node-test\/test\] node --test — in app\/$/.test(dl[1] ?? '') && discover.data.outcome === 'no-change', discover.data.result)
  const run = await call(root, { op: 'run' })
  check('B2 the run executes in app/ and reads its one failing test; the ran: line says where', run.data.record?.framework === 'node-test' && run.data.record?.cwd === path.join(root, 'app') && run.data.record?.counts.failed === 1 && run.data.result.split('\n')[0] === 'ran: node --test --test-reporter tap (in app/)', run.data.result)
  const insideRun = await call(path.join(root, 'app'), { op: 'report' })
  check('B2 read from inside the package, the same record\'s ran: line carries no folder', insideRun.data.record?.id === run.data.record?.id && insideRun.data.result.split('\n')[0] === 'ran: node --test --test-reporter tap', insideRun.data.result)
  const report = await call(root, { op: 'report' })
  check('B3 report at the root finds the record that landed under app/', report.data.record?.id === run.data.record?.id && report.data.result.split('\n')[0]!.endsWith(' (in app/)'), report.data.result)
  const byId = await call(root, { op: 'report', runId: run.data.record!.id })
  check('B3 report by id finds it too', byId.data.record?.id === run.data.record?.id, byId.data.result)
  const rerun = await call(root, { op: 'rerunFailed' })
  check('B4 rerunFailed at the root reruns the routed record\'s one failure', rerun.data.record?.selection === 'rerun-failed' && rerun.data.record?.counts.failed === 1 && rerun.data.record?.cwd === path.join(root, 'app') && rerun.data.result.split('\n')[0]!.endsWith(' (in app/)'), rerun.data.result)
  writeFileSync(path.join(root, 'app', 'test_y.py'), 'def test_y():\n    assert True\n')
  check('B5 a python test file inside the manifest-carrying package never outranks its manifest', runners.resolveTestLane(root).lane === 'runner', JSON.stringify(runners.resolveTestLane(root)).slice(0, 200))
  writeFileSync(path.join(root, 'test_root.py'), 'def test_root():\n    assert True\n')
  check('B6 a python test file at the root level is the root\'s own signal — the python lane', runners.resolveTestLane(root).lane === 'python', JSON.stringify(runners.resolveTestLane(root)).slice(0, 200))
  rmSync(root, { recursive: true, force: true })
}

section('C. two sub-packages declare runners — named with each one\'s runner; framework: picks the one package that declares it; a runner declared in two packages names both; one declared nowhere is runner-missing with the list')
{
  const root = mkdtempSync(path.join(scratch, 'two-'))
  nodeTestPackage(root, 'app')
  vitestPackage(root, 'web')
  const run = await call(root, { op: 'run' })
  check('C1 the packages are named with their runners', run.data.result === 'this project declares its manifests one level down — app/ (package.json: node-test), web/ (package.json: vitest) — pass framework: to pick one, or run from the package' && run.data.outcome === 'no-change', run.data.result)
  const nodeTest = await call(root, { op: 'run', framework: 'node-test' })
  check('C2 framework:node-test routes to app/ and runs its passing test', nodeTest.data.record?.cwd === path.join(root, 'app') && nodeTest.data.record?.counts.passed === 1 && nodeTest.data.outcome === 'succeeded', nodeTest.data.result)
  const vitest = await call(root, { op: 'run', framework: 'vitest' })
  check('C3 framework:vitest routes to web/ and answers with its honest availability (no node_modules)', vitest.data.result.startsWith('test run unavailable: vitest is declared but node_modules/.bin/vitest is missing'), vitest.data.result)
  const jest = await call(root, { op: 'run', framework: 'jest' })
  check('C4 a framework no package declares is runner-missing with the list', jest.data.result === 'no jest test profile in this project\'s manifests — one level down: app/ (package.json: node-test), web/ (package.json: vitest)' && jest.data.outcome === 'failed', jest.data.result)
  nodeTestPackage(root, 'lib')
  const twice = await call(root, { op: 'run', framework: 'node-test' })
  check('C5 a runner declared in two packages names both and runs nothing', twice.data.result === 'node-test is declared in more than one package below this root — app/ (package.json: node-test), lib/ (package.json: node-test) — run from the package' && twice.data.outcome === 'no-change', twice.data.result)
  rmSync(root, { recursive: true, force: true })
}

section('D. the bounds: one level only, node_modules, dot-folders and build output never read, and a root with its own manifest never consults the packages below it')
{
  const root = mkdtempSync(path.join(scratch, 'bounds-'))
  barePackage(root, 'node_modules/dep')
  barePackage(root, '.hidden')
  barePackage(root, 'dist')
  barePackage(root, 'deep/nested')
  const below = (runners as { discoverSubPackages?: (root: string) => Array<{ dir: string }> }).discoverSubPackages ?? (() => null)
  check('D1 nothing one level down counts', below(root)?.length === 0, JSON.stringify(below(root)))
  check('D1 the lane is the python default as before (no signal at all)', runners.resolveTestLane(root).lane === 'python', JSON.stringify(runners.resolveTestLane(root)))
  nodeTestPackage(root, 'app')
  check('D2 app/ counts', below(root)?.map(s => s.dir).join(',') === 'app', JSON.stringify(below(root)?.map(s => s.dir)))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true, scripts: { test: 'node --test' } }) + '\n')
  mkdirSync(path.join(root, 'test'))
  writeFileSync(path.join(root, 'test', 'root.test.mjs'), `import { test } from 'node:test'\ntest('root', () => {})\n`)
  const lane = runners.resolveTestLane(root)
  check('D3 a root with its own manifest is the root (findRunnerRoot\'s law unchanged)', lane.lane === 'runner' && lane.lane === 'runner' && lane.profile.root === root, JSON.stringify(lane).slice(0, 200))
  rmSync(root, { recursive: true, force: true })
}

rmSync(scratch, { recursive: true, force: true })
clearTimeout(guard)
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'sub-package-manifests: ALL LAWS HOLD' : `sub-package-manifests: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
