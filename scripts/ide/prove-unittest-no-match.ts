#!/usr/bin/env bun
// gate-watch: src/services/ide/pythonTests* src/tools/TestTool/*
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'unittest-no-match-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_TESTS
const SYS_PY = process.platform === 'win32' ? 'python' : '/usr/bin/python3'
process.env.MERCURY_PYTHON ??= SYS_PY

const pythonTests = await import('../../src/services/ide/pythonTests.ts')
const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
type TestRunRecord = import('../../src/services/ide/pythonTests.ts').TestRunRecord

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — unittest no-match proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

if (process.platform !== 'win32' && !existsSync(SYS_PY) && !process.env.MERCURY_PYTHON) {
  console.log(`  [SKIP — LOUD] ${SYS_PY} absent — the proof needs one interpreter`)
  process.exit(0)
}

const proj = mkdtempSync(path.join(tmpdir(), 'unittest-no-match-'))
mkdirSync(path.join(proj, 'tests'))
mkdirSync(path.join(proj, 'empty'))
writeFileSync(path.join(proj, 'tests', '__init__.py'), '')
writeFileSync(path.join(proj, 'tests', 'test_sum.py'), 'import unittest\n\nclass TestSum(unittest.TestCase):\n    def test_adds(self):\n        self.assertEqual(2 + 3, 5)\n')
writeFileSync(path.join(proj, 'tests', 'test_broken.py'), 'import unittest\nimport no_such_dependency\n\nclass TestBroken(unittest.TestCase):\n    def test_x(self):\n        pass\n')

const zero = (c: TestRunRecord['counts']): boolean => c.passed === 0 && c.failed === 0 && c.errored === 0 && c.skipped === 0
const run = (selection: string[], selectionLabel: string) => pythonTests.runPythonTests({ from: proj, framework: 'unittest', selection, selectionLabel })
function expectNoMatch(label: string, out: Awaited<ReturnType<typeof run>>, selection: string, words: string): void {
  if (out.state !== 'ok') {
    check(`${label}: the run is a record`, false, JSON.stringify(out).slice(0, 300))
    return
  }
  const r = out.record
  check(`${label}: the verdict word is no-match`, r.verdict === 'no-match', JSON.stringify({ verdict: r.verdict, counts: r.counts, note: r.verdictNote }))
  check(`${label}: counts read 0/0/0/0 (never 1 errored)`, zero(r.counts), JSON.stringify(r.counts))
  check(`${label}: the note says no test matched ${selection} and carries the loader's own words`, (r.verdictNote ?? '').startsWith(`no test matched ${selection} — `) && (r.verdictNote ?? '').includes(words), r.verdictNote ?? '(no note)')
  check(`${label}: no case rows and no failure rows are invented`, r.cases.length === 0 && r.failures.length === 0, JSON.stringify({ cases: r.cases.map(c => c.id), failures: r.failures }))
  check(`${label}: the exit code is 5, the no-tests-ran code, never 0`, r.exitCode === 5, String(r.exitCode))
}

section('A. a node id that names nothing — a method, a class, a module — is no-match with the loader\'s words (RED on the base: one errored unittest.loader._FailedTest)')
expectNoMatch('A1 a missing method', await run(['tests.test_sum.TestSum.test_nothing'], 'nodes:tests.test_sum.TestSum.test_nothing'), 'nodes:tests.test_sum.TestSum.test_nothing', "AttributeError: type object 'TestSum' has no attribute 'test_nothing'")
expectNoMatch('A2 a missing class', await run(['tests.test_sum.TestNothing'], 'nodes:tests.test_sum.TestNothing'), 'nodes:tests.test_sum.TestNothing', "has no attribute 'TestNothing'")
expectNoMatch('A3 a missing module', await run(['tests.test_nothing'], 'nodes:tests.test_nothing'), 'nodes:tests.test_nothing', "ModuleNotFoundError: No module named 'tests.test_nothing'")
expectNoMatch('A4 a file path that does not exist', await run([path.join(proj, 'tests', 'test_nothing.py')], 'file:tests/test_nothing.py'), 'file:tests/test_nothing.py', 'no such file or directory')

section('B. a module that exists but fails to import is a real error, never a no-match')
{
  const out = await run(['tests.test_broken'], 'nodes:tests.test_broken')
  check('B1 the broken module stays one errored _FailedTest with its import error', out.state === 'ok' && out.record.verdict === undefined && out.record.counts.errored === 1 && out.record.cases.some(c => c.id.includes('_FailedTest') && /no_such_dependency/.test(c.message ?? '')), out.state === 'ok' ? JSON.stringify({ verdict: out.record.verdict, counts: out.record.counts, cases: out.record.cases.map(c => `${c.id}: ${(c.message ?? '').slice(0, 80)}`) }) : out.state)
  check('B1 its exit code is 1', out.state === 'ok' && out.record.exitCode === 1, out.state === 'ok' ? String(out.record.exitCode) : out.state)
}

section('C. a selection where one name ran and one matched nothing keeps the real counts and names the miss; the run is not a pass')
{
  const out = await run(['tests.test_sum.TestSum.test_adds', 'tests.test_sum.TestSum.test_nothing'], 'nodes:two')
  check('C1 one passed, nothing errored, no verdict word', out.state === 'ok' && out.record.verdict === undefined && out.record.counts.passed === 1 && out.record.counts.errored === 0, out.state === 'ok' ? JSON.stringify({ verdict: out.record.verdict, counts: out.record.counts }) : out.state)
  check('C1 the note names the one selection that matched nothing with the loader\'s words', out.state === 'ok' && (out.record.verdictNote ?? '').startsWith('1 of the selection matched no test — tests.test_sum.TestSum.test_nothing: AttributeError'), out.state === 'ok' ? out.record.verdictNote ?? '(no note)' : out.state)
  check('C1 the exit code is 1', out.state === 'ok' && out.record.exitCode === 1, out.state === 'ok' ? String(out.record.exitCode) : out.state)
}

section('D. the control shapes keep their words: the real node passes; a folder with no tests and a file with no TestCase stay no-match with unittest\'s Ran 0 tests')
{
  const real = await run(['tests.test_sum.TestSum.test_adds'], 'nodes:tests.test_sum.TestSum.test_adds')
  check('D1 the real node passes, exit 0, no note', real.state === 'ok' && real.record.verdict === undefined && real.record.counts.passed === 1 && real.record.exitCode === 0 && real.record.verdictNote === undefined, real.state === 'ok' ? JSON.stringify({ counts: real.record.counts, exit: real.record.exitCode, note: real.record.verdictNote }) : real.state)
  const folder = await run([path.join(proj, 'empty')], 'file:empty')
  check('D2 an empty folder is no-match with Ran 0 tests', folder.state === 'ok' && folder.record.verdict === 'no-match' && /Ran 0 tests/.test(folder.record.verdictNote ?? ''), folder.state === 'ok' ? folder.record.verdictNote ?? '' : folder.state)
}

section('E. the Test tool road: the outcome word is no-change, the result reads the no-match line, and rerunFailed names the no-match instead of "no failures"')
{
  const result = await runWithCwdOverride(proj, () => TestTool.call({ op: 'run', framework: 'unittest', node: 'tests.test_sum.TestSum.test_nothing' } as never, { getAppState: () => ({}) } as never)) as { data: { outcome: string; result: string; record?: TestRunRecord }; effect: { outcome: string } }
  check('E1 data.outcome and effect.outcome are no-change', result.data.outcome === 'no-change' && result.effect.outcome === 'no-change', `${result.data.outcome} ${result.effect.outcome}`)
  const lines = result.data.result.split('\n')
  check('E1 the second line is the no-match line with the loader\'s words', lines[1] === "unittest no test matched nodes:tests.test_sum.TestSum.test_nothing — AttributeError: type object 'TestSum' has no attribute 'test_nothing'", lines[1] ?? '')
  check('E1 the third line carries the zero counts', (lines[2] ?? '').startsWith('counts: 0 passed · 0 failed · 0 skipped · 0 errored'), lines[2] ?? '')
  check('E1 the result never lists a _FailedTest failure row', !result.data.result.includes('_FailedTest') && !result.data.result.includes('1 errored'), result.data.result)
  const rerun = await pythonTests.rerunFailedTests({ from: proj })
  check('E2 rerunFailed after a no-match says the run matched no test, never "had no failures"', rerun.state === 'nothing-to-rerun' && /matched no test — nothing to rerun; no test matched nodes:tests.test_sum.TestSum.test_nothing/.test(rerun.note) && !/had no failures/.test(rerun.note), JSON.stringify(rerun).slice(0, 300))
}

section('F. discovery is unchanged: the loadable test is listed and the broken module is a collect error')
{
  const discovered = await pythonTests.discoverPythonTests({ from: proj, framework: 'unittest' })
  const ok = !('state' in discovered)
  check('F1 the one loadable test is discovered', ok && discovered.tests.includes('tests.test_sum.TestSum.test_adds'), JSON.stringify(discovered).slice(0, 300))
  check('F1 the broken module is named as a collect error', ok && discovered.collectErrors.some(e => /Failed to import test module: tests\.test_broken/.test(e)), JSON.stringify(discovered).slice(0, 300))
}

rmSync(proj, { recursive: true, force: true })
clearTimeout(guard)
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'unittest-no-match: ALL LAWS HOLD' : `unittest-no-match: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
