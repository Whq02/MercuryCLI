#!/usr/bin/env bun
// gate-watch: src/services/ide/pythonProject* src/services/ide/pythonTests* src/services/ide/projectRunners* src/tools/TestTool/* src/services/resources/adapters/test*
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'bare-test-files-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_TESTS
delete process.env.MERCURY_HOME

const pythonTests = await import('../../src/services/ide/pythonTests.ts')
const pythonProject = await import('../../src/services/ide/pythonProject.ts')
const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
await import('../../src/services/resources/adapters/test.ts')
const { resolveResource } = await import('../../src/services/resources/registry.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
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
  console.log('\nTIMEOUT — bare-test-files proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

const scratch = mkdtempSync(path.join(tmpdir(), 'bare-test-files-'))
const importsPytest = (py: string): boolean => {
  const r = spawnSync(py, ['-c', 'import pytest'], { stdio: 'ignore', timeout: 20_000 })
  return r.status === 0
}
const pytestPython = ((): string | null => {
  const named = process.env.MERCURY_PROOF_PYTEST_PYTHON
  if (named) return importsPytest(named) ? named : null
  for (const candidate of ['python3', 'python']) if (importsPytest(candidate)) return candidate
  return null
})()
const bareLadder = ((): string => {
  if (pytestPython !== null) {
    const stub = path.join(scratch, 'python-without-pytest')
    writeFileSync(stub, `#!/bin/sh\nexec ${JSON.stringify(pytestPython)} -S "$@"\n`)
    chmodSync(stub, 0o755)
    return stub
  }
  return process.platform === 'win32' ? 'python' : 'python3'
})()
check('S0 the stub ladder carries no pytest', !importsPytest(bareLadder), bareLadder)

const SUM_TESTS = 'def add(a, b):\n    return a + b\n\ndef test_adds_two():\n    assert add(1, 1) == 2\n\ndef test_adds_three():\n    assert add(1, 2) == 3\n\ndef test_wrong_on_purpose():\n    assert add(2, 2) == 5\n'
const MOCK_TESTS = 'from unittest.mock import patch\nfrom unittest import mock\n\ndef test_patched():\n    with patch("os.getcwd", return_value="/x"):\n        import os\n        assert os.getcwd() == "/x"\n\ndef test_mock_object():\n    assert mock.Mock()() is not None\n'
const UNITTEST_TESTS = 'import unittest\n\nclass TestCalc(unittest.TestCase):\n    def test_adds(self):\n        self.assertEqual(1 + 1, 2)\n\n    def test_multiplies(self):\n        self.assertEqual(2 * 3, 6)\n'
const UNITTEST_FROM_IMPORT = 'from unittest import TestCase\n\nclass TestFromImport(TestCase):\n    def test_one(self):\n        self.assertTrue(True)\n'
const BARE_WITH_FAILURE = 'def test_bare_passes():\n    assert 1 == 1\n\ndef test_bare_fails():\n    assert 1 == 2\n'

function bareProject(files: Record<string, string> = { 'test_sum.py': SUM_TESTS }): string {
  const root = path.join(mkdtempSync(path.join(scratch, 'box-')), '7b1 spaced pytest')
  mkdirSync(root)
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text)
  return root
}
function unittestProject(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(scratch, 'unit-'))
  mkdirSync(path.join(root, 'tests'))
  writeFileSync(path.join(root, 'tests', '__init__.py'), '')
  writeFileSync(path.join(root, 'tests', 'test_calc.py'), UNITTEST_TESTS)
  for (const [name, text] of Object.entries(extra)) writeFileSync(path.join(root, 'tests', name), text)
  return root
}
function pin(interpreter: string): void {
  process.env.MERCURY_PYTHON = interpreter
  pythonProject._resetPythonProjectForTesting()
  pythonTests._resetPytestProbeForTesting()
}
const call = (root: string, input: Record<string, unknown>): Promise<ToolAnswer> =>
  runWithCwdOverride(root, () => TestTool.call(input as never, { getAppState: () => ({}) } as never)) as Promise<ToolAnswer>
const zero = (c: TestRunRecord['counts']): boolean => c.passed === 0 && c.failed === 0 && c.errored === 0 && c.skipped === 0

section('A. the box\'s shape (F37W-7B-06): test_sum.py with three bare tests and no marker on a path with a space, pytest importable for the pinned interpreter — the pytest lane runs it (RED on the base: "unittest: 0 test(s)" and a 0/0/0/0 run)')
if (pytestPython !== null) {
  const root = bareProject()
  pin(pytestPython)
  const profile = pythonProject.buildPythonProjectProfile(root)
  check('A1 the bare test file is pytest evidence, not a configured marker', profile.testFrameworks.pytest.detected === true && profile.testFrameworks.pytest.configured === false && (profile.testFrameworks.pytest.evidence ?? '').includes('test_sum.py'), JSON.stringify(profile.testFrameworks))
  check('A1 the profile names the test files it found', JSON.stringify(profile.testFrameworks.testFiles) === JSON.stringify(['test_sum.py']), JSON.stringify(profile.testFrameworks.testFiles))
  check('A1 nothing claims unittest for it', profile.testFrameworks.unittest.detected === false, JSON.stringify(profile.testFrameworks.unittest))
  const discover = await call(root, { op: 'discover' })
  check('A2 discover lists the three pytest nodes', discover.data.result.startsWith('pytest: 3 test(s)') && discover.data.result.includes('test_sum.py::test_wrong_on_purpose'), discover.data.result)
  const run = await call(root, { op: 'run' })
  const r = run.data.record
  check('A3 run takes the pytest lane: 2 passed · 1 failed', r !== undefined && r.framework === 'pytest' && r.counts.passed === 2 && r.counts.failed === 1 && r.verdict === undefined, JSON.stringify(r?.counts) + (r?.verdict ?? ''))
  check('A3 the failing node is named', r !== undefined && r.failures.length === 1 && r.failures[0] === 'test_sum.py::test_wrong_on_purpose', JSON.stringify(r?.failures))
  check('A3 the result reads the pytest line, never a zero run', run.data.result.includes('pytest all — 2 passed · 1 failed') && !run.data.result.includes('ran 0'), run.data.result)
  check('A3 the spaced path rides as the cwd untouched', r !== undefined && r.cwd === root && r.cwd.includes(' '), r?.cwd ?? '')
  const rerun = await call(root, { op: 'rerunFailed' })
  const rr = rerun.data.record
  check('A4 rerunFailed runs exactly the one failing node', rr !== undefined && rr.selection === 'rerun-failed' && rr.counts.failed === 1 && rr.counts.passed === 0 && rr.command.includes('test_sum.py::test_wrong_on_purpose'), JSON.stringify({ sel: rr?.selection, counts: rr?.counts }))
  rmSync(path.dirname(root), { recursive: true, force: true })

  const mocked = bareProject({ 'test_svc.py': MOCK_TESTS })
  pin(pytestPython)
  const mockProfile = pythonProject.buildPythonProjectProfile(mocked)
  check('A5 a pytest file whose only unittest words are unittest.mock imports is pytest evidence, never unittest\'s (the import alone decides nothing)', mockProfile.testFrameworks.pytest.detected === true && mockProfile.testFrameworks.unittest.detected === false && JSON.stringify(mockProfile.testFrameworks.bareFiles) === JSON.stringify(['test_svc.py']), JSON.stringify(mockProfile.testFrameworks))
  const mockDiscover = await call(mocked, { op: 'discover' })
  check('A5 discover lists its two pytest nodes', mockDiscover.data.result.startsWith('pytest: 2 test(s)') && mockDiscover.data.result.includes('test_svc.py::test_patched'), mockDiscover.data.result)
  const mockRun = await call(mocked, { op: 'run' })
  check('A5 run takes the pytest lane: 2 passed, outcome succeeded, no NOTE', mockRun.data.record?.framework === 'pytest' && mockRun.data.record?.counts.passed === 2 && mockRun.data.outcome === 'succeeded' && !mockRun.data.result.includes('NOTE:'), mockRun.data.result)
  rmSync(path.dirname(mocked), { recursive: true, force: true })

  const mixed = unittestProject({ 'test_bare.py': BARE_WITH_FAILURE })
  pin(pytestPython)
  const mixedRun = await call(mixed, { op: 'run' })
  check('A6 a mixed project (TestCase file + bare file) with pytest importable runs all four under pytest, the bare failure counted', mixedRun.data.record?.framework === 'pytest' && mixedRun.data.record?.counts.passed === 3 && mixedRun.data.record?.counts.failed === 1 && mixedRun.data.record?.verdict === undefined, JSON.stringify({ fw: mixedRun.data.record?.framework, counts: mixedRun.data.record?.counts, verdict: mixedRun.data.record?.verdict }))
  const explicitUnit = await call(mixed, { op: 'run', framework: 'unittest' })
  check('A7 framework:"unittest" on the mixed project with pytest importable: the bare file is named as not collected with the pytest remedy, the outcome is not succeeded', explicitUnit.data.record?.verdict === 'uncollected' && explicitUnit.data.record?.counts.passed === 2 && explicitUnit.data.outcome === 'failed' && (explicitUnit.data.record?.verdictNote ?? '') === '1 test file(s) not collected (tests/test_bare.py) — the unittest lane collects unittest.TestCase classes from test*.py files only; pass framework: "pytest" to run them under pytest', explicitUnit.data.result)
  rmSync(mixed, { recursive: true, force: true })
} else {
  console.log('  [SKIP — LOUD] no interpreter on this machine imports pytest — point MERCURY_PROOF_PYTEST_PYTHON at one (a venv with pytest) to run the pytest arm; the stub-ladder arms below still run')
}

section('B. the same files with pytest absent from the ladder — a zero-run is neither passed nor clean: the files and the lane are named with the remedy (RED on the base: "no test ran — Ran 0 tests", outcome no-change, no hint)')
{
  const root = bareProject()
  pin(bareLadder)
  const profile = pythonProject.buildPythonProjectProfile(root)
  check('B1 the bare file is still pytest-shaped evidence (the lane decision is the probe\'s)', profile.testFrameworks.pytest.detected === true && profile.testFrameworks.pytest.configured === false, JSON.stringify(profile.testFrameworks.pytest))
  const discover = await call(root, { op: 'discover' })
  const lines = discover.data.result.split('\n')
  check('B2 discover says unittest collected 0 and names the uncollected file, the lane and the remedy', lines[0] === 'unittest: 0 test(s)' && lines[1] === `NOTE: 1 test file(s) not collected (test_sum.py) — the unittest lane collects unittest.TestCase classes from test*.py files only; pytest is not importable for ${bareLadder}; install it (pip install pytest) or name the framework`, discover.data.result)
  const run = await call(root, { op: 'run' })
  const r = run.data.record
  check('B3 the record\'s verdict word is zero-run with zero counts and no invented rows', r !== undefined && r.verdict === 'zero-run' && zero(r.counts) && r.failures.length === 0 && r.cases.length === 0, JSON.stringify({ verdict: r?.verdict, counts: r?.counts }))
  check('B3 the note names the files found, the lane that ran nothing and why', (r?.verdictNote ?? '').startsWith(`1 test file(s) found (test_sum.py), the unittest lane ran 0 — pytest is not importable for ${bareLadder}; install it (pip install pytest) or name the framework`), r?.verdictNote ?? '(no note)')
  check('B3 the outcome is failed, not succeeded and not no-change', run.data.outcome === 'failed' && run.effect.outcome === 'failed', `${run.data.outcome} / ${run.effect.outcome}`)
  const rl = run.data.result.split('\n')
  check('B3 the result reads the zero-run line second and the zero counts third', rl[1] === r?.verdictNote && (rl[2] ?? '').startsWith('counts: 0 passed · 0 failed · 0 skipped · 0 errored'), run.data.result)
  check('B3 the result never says "no test matched" or "no test ran"', !run.data.result.includes('no test matched') && !run.data.result.includes('no test ran'), run.data.result)
  check('B3 the fallback suffix is not added on top of the zero-run words', run.data.result.split('NOTE:').length === 1, run.data.result)
  const inspected = await runWithCwdOverride(root, () => resolveResource(`mercury://test/run/${r!.id}`, { owner: makeOwnerKey({ workspace: root, sessionId: 'bare-test-files-proof', lane: 'main' }), cwd: root }))
  check('B4 the Inspect view says test files were found and 0 ran', inspected.state === 'ok' && inspected.resource.summary.includes('test files found, 0 ran'), JSON.stringify(inspected).slice(0, 240))
  const rerun = await call(root, { op: 'rerunFailed' })
  check('B5 rerunFailed after a zero-run says so instead of "had no failures"', rerun.data.outcome === 'no-change' && rerun.data.result.includes('ran 0 tests — nothing to rerun') && rerun.data.result.includes('the unittest lane ran 0'), rerun.data.result)
  const explicit = await call(root, { op: 'run', framework: 'unittest' })
  check('B6 an explicit framework still runs that lane; its empty run is a zero-run too, with no fallback note', explicit.data.record?.framework === 'unittest' && explicit.data.record?.verdict === 'zero-run' && !explicit.data.result.includes('NOTE:'), explicit.data.result)
  rmSync(path.dirname(root), { recursive: true, force: true })

  const mixed = unittestProject({ 'test_bare.py': BARE_WITH_FAILURE })
  pin(bareLadder)
  const mixedDiscover = await call(mixed, { op: 'discover' })
  const md = mixedDiscover.data.result.split('\n')
  check('B7 a mixed project without pytest: discover counts the two TestCase tests and names exactly the file the unittest lane did not collect', md[0] === 'unittest: 2 test(s)' && md[1] === `NOTE: 1 test file(s) not collected (tests/test_bare.py) — the unittest lane collects unittest.TestCase classes from test*.py files only; pytest is not importable for ${bareLadder}; install it (pip install pytest) or name the framework`, mixedDiscover.data.result)
  const mixedRun = await call(mixed, { op: 'run' })
  const mr = mixedRun.data.record
  check('B7 the run that skipped a test file is never succeeded: verdict uncollected, the two tests that ran counted, the skipped file named once', mr?.verdict === 'uncollected' && mr?.counts.passed === 2 && mr?.counts.failed === 0 && mixedRun.data.outcome === 'failed' && mixedRun.effect.outcome === 'failed' && mr?.verdictNote === `1 test file(s) not collected (tests/test_bare.py) — the unittest lane collects unittest.TestCase classes from test*.py files only; pytest is not importable for ${bareLadder}; install it (pip install pytest) or name the framework`, mixedRun.data.result)
  check('B7 the result reads the counts line then one NOTE with the skipped file, never the all-files list', mixedRun.data.result.includes('unittest all — 2 passed · 0 failed') && mixedRun.data.result.split('NOTE:').length === 2 && !mixedRun.data.result.includes('tests/test_calc.py'), mixedRun.data.result)
  const mixedInspect = await runWithCwdOverride(mixed, () => resolveResource(`mercury://test/run/${mr!.id}`, { owner: makeOwnerKey({ workspace: mixed, sessionId: 'bare-test-files-proof', lane: 'main' }), cwd: mixed }))
  check('B7 the Inspect view says test files were not collected', mixedInspect.state === 'ok' && mixedInspect.resource.summary.includes('test files not collected'), JSON.stringify(mixedInspect).slice(0, 240))
  const mixedRerun = await call(mixed, { op: 'rerunFailed' })
  check('B7 rerunFailed after it says the skipped file beside "no failures"', mixedRerun.data.outcome === 'no-change' && mixedRerun.data.result.includes('had no failures among the tests it ran; 1 test file(s) not collected (tests/test_bare.py)'), mixedRerun.data.result)
  rmSync(mixed, { recursive: true, force: true })
}

section('C. a real unittest project (tests/test_calc.py derives from unittest.TestCase; a second file spells it `from unittest import TestCase`) stays unittest on both ladders and runs its three tests')
for (const [label, interpreter] of [['the pytest-carrying interpreter', pytestPython], ['the stub ladder', bareLadder]] as const) {
  if (interpreter === null) {
    console.log(`  [SKIP — LOUD] ${label}: none on this machine`)
    continue
  }
  const root = unittestProject({ 'test_from_import.py': UNITTEST_FROM_IMPORT })
  pin(interpreter)
  const profile = pythonProject.buildPythonProjectProfile(root)
  check(`C1 ${label}: the TestCase class is the evidence, pytest is not detected, no file is bare`, profile.testFrameworks.unittest.detected === true && profile.testFrameworks.unittest.evidence === 'tests/test_calc.py carries unittest.TestCase / unittest.main' && profile.testFrameworks.pytest.detected === false && profile.testFrameworks.bareFiles.length === 0, JSON.stringify(profile.testFrameworks))
  const run = await call(root, { op: 'run' })
  const r = run.data.record
  check(`C2 ${label}: the run is unittest with 3 passed and no verdict word`, r !== undefined && r.framework === 'unittest' && r.counts.passed === 3 && r.verdict === undefined && run.data.outcome === 'succeeded', JSON.stringify({ fw: r?.framework, counts: r?.counts, verdict: r?.verdict, outcome: run.data.outcome }))
  check(`C2 ${label}: no fallback note is appended`, !run.data.result.includes('NOTE:'), run.data.result)
  rmSync(root, { recursive: true, force: true })
}

section('D. the laws that stay: a project with no test files keeps the no-match verdict (no-change), and a selection that runs nothing in a project with files is a no-match, never a zero-run')
{
  const empty = mkdtempSync(path.join(scratch, 'empty-'))
  writeFileSync(path.join(empty, 'pyproject.toml'), '[project]\nname = "empty"\nversion = "0"\n')
  pin(bareLadder)
  const run = await call(empty, { op: 'run' })
  check('D1 no test files: verdict no-match, outcome no-change, the lane\'s own words', run.data.record?.verdict === 'no-match' && run.data.outcome === 'no-change' && run.data.result.includes('unittest no test ran — Ran 0 tests'), run.data.result)
  const root = bareProject()
  mkdirSync(path.join(root, 'empty_dir'))
  pin(bareLadder)
  const selected = await call(root, { op: 'run', framework: 'unittest', path: 'empty_dir' })
  check('D2 a selection that runs nothing is a no-match naming the selection', selected.data.record?.verdict === 'no-match' && selected.data.outcome === 'no-change' && selected.data.result.includes('no test matched file:empty_dir'), selected.data.result)
  rmSync(empty, { recursive: true, force: true })
  rmSync(path.dirname(root), { recursive: true, force: true })
}

section('E. the scan is bounded and shaped: tests/, test/ and the root to depth 2, dot-folders, node_modules, venv and __pycache__ never entered, forward slashes, sorted')
{
  const root = mkdtempSync(path.join(scratch, 'scan-'))
  for (const dir of ['tests/unit', 'test', 'src/pkg', 'node_modules/x', '.hidden', 'venv/lib', '__pycache__', 'a/b/c']) mkdirSync(path.join(root, dir), { recursive: true })
  for (const file of ['test_root.py', 'root_test.py', 'tests/test_a.py', 'tests/unit/test_b.py', 'test/test_c.py', 'src/pkg/test_d.py', 'node_modules/x/test_no.py', '.hidden/test_no.py', 'venv/lib/test_no.py', '__pycache__/test_no.py', 'a/b/c/test_deep.py', 'helper.py', 'testing.py']) writeFileSync(path.join(root, file), '')
  const scanner = (pythonProject as { findPythonTestFiles?: (root: string, skip?: ReadonlySet<string>) => string[] }).findPythonTestFiles
  const found = scanner ? scanner(root) : null
  check('E1 the files found', JSON.stringify(found) === JSON.stringify(['root_test.py', 'src/pkg/test_d.py', 'test/test_c.py', 'test_root.py', 'tests/test_a.py', 'tests/unit/test_b.py']), JSON.stringify(found))
  const skipped = scanner ? scanner(root, new Set(['src', 'tests'])) : null
  check('E2 top-level folders in skipDirs are never entered', JSON.stringify(skipped) === JSON.stringify(['root_test.py', 'test/test_c.py', 'test_root.py']), JSON.stringify(skipped))
  rmSync(root, { recursive: true, force: true })
}

rmSync(scratch, { recursive: true, force: true })
clearTimeout(guard)
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'bare-test-files: ALL LAWS HOLD' : `bare-test-files: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
