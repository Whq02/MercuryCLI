#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'pytest-collect-teardown-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_TESTS
delete process.env.MERCURY_HOME

const pythonTests = await import('../../src/services/ide/pythonTests.ts')
const pythonProject = await import('../../src/services/ide/pythonProject.ts')
const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
type TestRunRecord = import('../../src/services/ide/pythonTests.ts').TestRunRecord
type ToolAnswer = { data: { outcome: string; result: string; record?: TestRunRecord } }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — pytest collect/teardown proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'pytest-collect-teardown-')))
const importsPytest = (py: string): boolean => spawnSync(py, ['-c', 'import pytest'], { stdio: 'ignore', timeout: 20_000 }).status === 0
const pytestPython = ((): string | null => {
  const named = process.env.MERCURY_PROOF_PYTEST_PYTHON
  if (named) return importsPytest(named) ? named : null
  for (const candidate of ['python3', 'python']) if (importsPytest(candidate)) return candidate
  return null
})()
const stdlibPython = process.platform === 'win32' ? 'python' : existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3'

function pin(interpreter: string): void {
  process.env.MERCURY_PYTHON = interpreter
  pythonProject._resetPythonProjectForTesting()
  pythonTests._resetPytestProbeForTesting()
}
const call = (root: string, input: Record<string, unknown>): Promise<ToolAnswer> =>
  runWithCwdOverride(root, () => TestTool.call(input as never, { getAppState: () => ({}) } as never)) as Promise<ToolAnswer>
const rowOf = (result: string, id: string): string => {
  const lines = result.split('\n')
  const at = lines.findIndex(l => l.startsWith(`  ${id}`))
  return at === -1 ? '' : `${lines[at]}\n${lines[at + 1] ?? ''}`
}

const BROKEN_IMPORT = 'import nosuchmodule_mercury\n\ndef test_never_runs():\n    assert True\n'
const RAISES_AT_IMPORT = 'VALUE = 1\n\nraise RuntimeError("boom at import")\n\ndef test_never_runs():\n    assert True\n'
const TEARDOWN = 'import pytest\n\n@pytest.fixture\ndef resource():\n    yield "r"\n    raise RuntimeError("teardown blew up")\n\ndef test_uses_resource(resource):\n    assert resource == "r"\n\ndef test_plain():\n    assert True\n'
const DEEP_CHAIN = Array.from({ length: 8 }, (_, i) => (i === 0 ? 'def level_0(n):\n    values = [i * i for i in range(12)]\n    assert n == 2, "the deep assertion carries the real reason: %r" % (values,)\n' : `def level_${i}(n):\n    return level_${i - 1}(n)\n`)).join('\n')
const DEEP_PYTEST = `${DEEP_CHAIN}\ndef test_deep_failure():\n    level_7(1)\n\ndef test_passes():\n    assert 1 == 1\n`
const DEEP_UNITTEST = `import unittest\n\n${DEEP_CHAIN}\nclass TestDeep(unittest.TestCase):\n    def test_deep_failure(self):\n        level_7(1)\n\n    def test_passes(self):\n        self.assertTrue(True)\n`

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(scratch, 'proj-'))
  writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "fixture"\nversion = "0.0.1"\n')
  mkdirSync(path.join(root, 'tests'))
  writeFileSync(path.join(root, 'tests', '__init__.py'), '')
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, 'tests', name), text)
  return root
}

section('A. pytest: two modules that fail to collect — the run records them as errored cases, the result names each with its error, the outcome is failed, rerunFailed reruns exactly those files')
if (pytestPython !== null) {
  const root = project({ 'test_broken.py': BROKEN_IMPORT, 'test_raises_at_import.py': RAISES_AT_IMPORT, 'test_teardown.py': TEARDOWN, 'test_deep.py': DEEP_PYTEST })
  pin(pytestPython)
  const run = await call(root, { op: 'run', framework: 'pytest' })
  const r = run.data.record
  check('A1 the run lands on the pytest lane with exit 2 and nothing run', r !== undefined && r.framework === 'pytest' && r.exitCode === 2 && r.counts.passed === 0 && r.counts.failed === 0, JSON.stringify({ fw: r?.framework, exit: r?.exitCode, counts: r?.counts }))
  check('A2 the two collect errors are errored cases, counted once each', r !== undefined && r.counts.errored === 2 && r.cases.length === 2 && r.cases.every(c => c.outcome === 'errored'), JSON.stringify(r?.cases.map(c => ({ id: c.id, outcome: c.outcome }))))
  const broken = r?.cases.find(c => c.id === 'tests/test_broken.py')
  const raises = r?.cases.find(c => c.id === 'tests/test_raises_at_import.py')
  check('A3 the import error carries the tail of its traceback: the import line and the ModuleNotFoundError', (broken?.message ?? '').includes("E   ModuleNotFoundError: No module named 'nosuchmodule_mercury'") && (broken?.message ?? '').includes('tests/test_broken.py:1: in <module>'), broken?.message ?? '')
  check('A4 the module-level raise carries its stop location: tests/test_raises_at_import.py:3', raises?.file === 'tests/test_raises_at_import.py' && raises?.line === 3 && (raises?.message ?? '').includes('E   RuntimeError: boom at import'), JSON.stringify({ file: raises?.file, line: raises?.line, message: raises?.message }))
  check('A5 failures[] carries both files as the rerun selection', r !== undefined && r.failures.length === 2 && r.failures.includes('tests/test_broken.py') && r.failures.includes('tests/test_raises_at_import.py'), JSON.stringify(r?.failures))
  check('A6 the Test tool outcome is failed, never succeeded', run.data.outcome === 'failed', run.data.outcome)
  check('A7 the result reads 2 errored and carries a failure row per broken module with the error text', run.data.result.includes('0 passed · 0 failed · 0 skipped · 2 errored') && run.data.result.includes('failures:') && rowOf(run.data.result, 'tests/test_broken.py').includes("E   ModuleNotFoundError: No module named 'nosuchmodule_mercury'") && rowOf(run.data.result, 'tests/test_raises_at_import.py').startsWith('  tests/test_raises_at_import.py (tests/test_raises_at_import.py:3)'), run.data.result)
  check('A8 no verdict note is invented for a run whose errors are recorded', r !== undefined && r.verdict === undefined && r.verdictNote === undefined, JSON.stringify({ verdict: r?.verdict, note: r?.verdictNote }))
  const rerun = await call(root, { op: 'rerunFailed' })
  const rr = rerun.data.record
  check('A9 rerunFailed reruns exactly the two broken files and records the same two errors', rr !== undefined && rr.selection === 'rerun-failed' && rr.command.includes('tests/test_broken.py') && rr.command.includes('tests/test_raises_at_import.py') && !rr.command.includes('tests/test_teardown.py') && rr.counts.errored === 2 && rerun.data.outcome === 'failed', JSON.stringify({ sel: rr?.selection, command: rr?.command, counts: rr?.counts, outcome: rerun.data.outcome }))

  section('B. pytest: a fixture whose teardown throws — the test is passed AND errored (pytest\'s own count), the errored row stops at the raise line')
  const teardown = await call(root, { op: 'run', framework: 'pytest', path: 'tests/test_teardown.py' })
  const t = teardown.data.record
  check('B1 counts read 2 passed · 1 errored, exit 1', t !== undefined && t.counts.passed === 2 && t.counts.errored === 1 && t.counts.failed === 0 && t.exitCode === 1, JSON.stringify({ counts: t?.counts, exit: t?.exitCode }))
  const errored = t?.cases.find(c => c.outcome === 'errored')
  check('B2 the errored case is the test whose teardown threw, stopped at tests/test_teardown.py:6', errored?.id === 'tests/test_teardown.py::test_uses_resource' && errored?.file === 'tests/test_teardown.py' && errored?.line === 6, JSON.stringify(errored))
  check('B3 its message is the traceback tail ending in the stop location', /E\s+RuntimeError: teardown blew up/.test(errored?.message ?? '') && (errored?.message ?? '').trimEnd().endsWith('tests/test_teardown.py:6: RuntimeError'), errored?.message ?? '')
  check('B4 failures[] names it for the rerun; the outcome is failed', t !== undefined && JSON.stringify(t.failures) === JSON.stringify(['tests/test_teardown.py::test_uses_resource']) && teardown.data.outcome === 'failed', JSON.stringify({ failures: t?.failures, outcome: teardown.data.outcome }))
  check('B5 the result row reads the id, the stop location, the error and its location line', rowOf(teardown.data.result, 'tests/test_teardown.py::test_uses_resource') === '  tests/test_teardown.py::test_uses_resource (tests/test_teardown.py:6)\n    E       RuntimeError: teardown blew up · tests/test_teardown.py:6: RuntimeError', rowOf(teardown.data.result, 'tests/test_teardown.py::test_uses_resource'))

  section('C. pytest: a traceback longer than the 800-character bound keeps its TAIL — the assertion and the stop location, not the outer frames')
  const deep = await call(root, { op: 'run', framework: 'pytest', path: 'tests/test_deep.py' })
  const d = deep.data.record
  const deepFail = d?.cases.find(c => c.outcome === 'failed')
  check('C1 1 passed · 1 failed', d !== undefined && d.counts.passed === 1 && d.counts.failed === 1, JSON.stringify(d?.counts))
  check('C2 the message is bounded at 800 characters and ends with the stop location', (deepFail?.message ?? '').length <= 800 && (deepFail?.message ?? '').length >= 700 && (deepFail?.message ?? '').trimEnd().endsWith('tests/test_deep.py:3: AssertionError'), `${(deepFail?.message ?? '').length} chars; tail ${JSON.stringify((deepFail?.message ?? '').slice(-120))}`)
  check('C3 the tail carries the assertion text', (deepFail?.message ?? '').includes('E       assert 1 == 2'), (deepFail?.message ?? '').slice(-300))
  check('C4 the failed case stops at tests/test_deep.py:3 (the assertion), not the test definition line', deepFail?.file === 'tests/test_deep.py' && deepFail?.line === 3, JSON.stringify({ file: deepFail?.file, line: deepFail?.line }))
  const passed = d?.cases.find(c => c.outcome === 'passed')
  check('C5 a passing case keeps its own definition line', (passed?.file ?? '').endsWith('tests/test_deep.py') && passed?.line === 29, JSON.stringify({ file: passed?.file, line: passed?.line }))
  check('C6 the result row reads the stop location and the last two traceback lines', rowOf(deep.data.result, 'tests/test_deep.py::test_deep_failure') === '  tests/test_deep.py::test_deep_failure (tests/test_deep.py:3)\n    E       assert 1 == 2 · tests/test_deep.py:3: AssertionError', rowOf(deep.data.result, 'tests/test_deep.py::test_deep_failure'))
  rmSync(root, { recursive: true, force: true })
} else {
  console.log('  [SKIP — LOUD] no interpreter on this machine imports pytest — point MERCURY_PROOF_PYTEST_PYTHON at one (a venv with pytest) to run the pytest arms; the unittest arm below still runs')
}

section('D. unittest (stdlib): a traceback longer than the bound keeps its tail — the assertion line rides the result row')
{
  const root = project({ 'test_deep.py': DEEP_UNITTEST })
  pin(stdlibPython)
  const run = await call(root, { op: 'run', framework: 'unittest' })
  const r = run.data.record
  const deepFail = r?.cases.find(c => c.outcome === 'failed')
  check('D1 1 passed · 1 failed on the unittest lane', r !== undefined && r.framework === 'unittest' && r.counts.passed === 1 && r.counts.failed === 1, JSON.stringify({ fw: r?.framework, counts: r?.counts }))
  check('D2 the message is bounded at 800 characters and ends with the AssertionError line', (deepFail?.message ?? '').length <= 800 && (deepFail?.message ?? '').trimEnd().endsWith('[0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121]'), `${(deepFail?.message ?? '').length} chars; tail ${JSON.stringify((deepFail?.message ?? '').slice(-160))}`)
  check('D3 the result row carries the assertion, with no blank line eating its place', rowOf(run.data.result, 'tests.test_deep.TestDeep.test_deep_failure').includes('AssertionError: the deep assertion carries the real reason') && !rowOf(run.data.result, 'tests.test_deep.TestDeep.test_deep_failure').endsWith(' · '), rowOf(run.data.result, 'tests.test_deep.TestDeep.test_deep_failure'))
  rmSync(root, { recursive: true, force: true })
}

rmSync(scratch, { recursive: true, force: true })
rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
clearTimeout(guard)
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'pytest-collect-teardown: ALL LAWS HOLD' : `pytest-collect-teardown: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
