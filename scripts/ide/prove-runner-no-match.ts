#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'runner-no-match-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_TESTS

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'runners')
const FIXTURE_ROOT = '/work/project'

const runners = await import('../../src/services/ide/projectRunners.ts')
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
  console.log('\nTIMEOUT — runner no-match proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')
const scratch = (label: string): string => mkdtempSync(path.join(tmpdir(), `runner-no-match-${label}-`))
const onPath = (bin: string): boolean => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

type StandIn = { exitCode: number; report: string | null; stdout: string }

function standInProject(runner: 'vitest' | 'jest', behaviour: StandIn): string {
  const root = scratch(runner)
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, devDependencies: { [runner]: '*' } }) + '\n')
  writeFileSync(path.join(root, 'bun.lock'), '{}\n')
  writeFileSync(path.join(root, runner === 'vitest' ? 'sum.test.mjs' : 'sum.test.js'), '\n')
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  const bin = path.join(root, 'node_modules', '.bin', runner)
  const report = behaviour.report === null ? null : behaviour.report.split(FIXTURE_ROOT).join(root)
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      `const out = process.argv.slice(2).find(a => a.startsWith('--outputFile='))`,
      `const report = ${JSON.stringify(report)}`,
      `if (out && report !== null) require('fs').writeFileSync(out.slice('--outputFile='.length), report)`,
      `process.stdout.write(${JSON.stringify(behaviour.stdout.split(FIXTURE_ROOT).join(root))})`,
      `process.exit(${behaviour.exitCode})`,
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return root
}

const zero = (c: TestRunRecord['counts']): boolean => c.passed === 0 && c.failed === 0 && c.errored === 0
async function expectNoMatchRerun(label: string, root: string, latestId: string, selection: string): Promise<void> {
  const rerun = await runWithCwdOverride(root, () => TestTool.call({ op: 'rerunFailed' } as never, { getAppState: () => ({}) } as never)) as { data: { outcome: string; result: string } }
  check(`${label}: rerunFailed after the no-match says the run matched no test, outcome no-change — the one wording of every lane`, rerun.data.outcome === 'no-change' && rerun.data.result.startsWith(`latest run ${latestId} matched no test — nothing to rerun; no test matched ${selection} — `) && !/rerun unavailable|no parsed failing nodes|had no failures/.test(rerun.data.result), `${rerun.data.outcome} ${rerun.data.result.slice(0, 300)}`)
}
function expectNoMatch(label: string, out: Awaited<ReturnType<typeof runners.runRunnerProfile>>, selection: string, words: string, skipped = 0): void {
  if (out.state !== 'ok') {
    check(`${label}: the run is a record, not an unavailable refusal`, false, JSON.stringify(out).slice(0, 300))
    return
  }
  const r = out.record
  check(`${label}: the record's verdict word is no-match`, r.verdict === 'no-match', JSON.stringify({ verdict: r.verdict, counts: r.counts, note: r.verdictNote }))
  check(`${label}: counts read 0 passed · 0 failed · ${skipped} skipped · 0 errored (never 1 failed)`, zero(r.counts) && r.counts.skipped === skipped, JSON.stringify(r.counts))
  check(`${label}: the note says no test matched ${selection} and quotes the runner's own words`, (r.verdictNote ?? '').startsWith(`no test matched ${selection} — `) && (r.verdictNote ?? '').includes(words), r.verdictNote ?? '(no note)')
  check(`${label}: no failure rows and no case rows are invented`, r.failures.length === 0 && r.cases.length === 0, JSON.stringify({ failures: r.failures, cases: r.cases.length }))
}

section('A. jest — the F37W-2A-01 shape: a describe name sent as a positional pattern matches no file (recorded jest 30.5.2; RED on the base: 0 passed · 1 failed, "counts not parsed")')
{
  const withReport = standInProject('jest', { exitCode: 1, report: fixture('jest-no-match-report.json'), stdout: fixture('jest-no-match.txt') })
  const profile = runners.discoverRunnerProfiles(withReport).profiles.find(p => p.runner === 'jest')!
  const out = await runners.runRunnerProfile(profile, { from: withReport, selection: 'math ops', selectionKind: 'node', selectionLabel: 'nodes:math ops' })
  expectNoMatch('A1 jest with its report written', out, 'nodes:math ops', 'Pattern: math ops - 0 matches')
  check('A1 the note carries both of jest\'s lines', out.state === 'ok' && (out.record.verdictNote ?? '').includes('No tests found, exiting with code 1'), out.state === 'ok' ? out.record.verdictNote ?? '' : out.state)

  const noReport = standInProject('jest', { exitCode: 1, report: null, stdout: fixture('jest-no-match.txt') })
  const profile2 = runners.discoverRunnerProfiles(noReport).profiles.find(p => p.runner === 'jest')!
  const out2 = await runners.runRunnerProfile(profile2, { from: noReport, selection: 'math ops', selectionKind: 'node', selectionLabel: 'nodes:math ops' })
  expectNoMatch('A2 jest with no report file (the Windows loop\'s shape: counts unparsed)', out2, 'nodes:math ops', 'Pattern: math ops - 0 matches')
  check('A2 the "counts not parsed" note is not added on top of the no-match words', out2.state === 'ok' && !(out2.record.verdictNote ?? '').includes('counts not parsed'), out2.state === 'ok' ? out2.record.verdictNote ?? '' : out2.state)

  const nameFilter = standInProject('jest', { exitCode: 0, report: fixture('jest-name-filter-no-match-report.json'), stdout: fixture('jest-name-filter-no-match.txt') })
  const profile3 = runners.discoverRunnerProfiles(nameFilter).profiles.find(p => p.runner === 'jest')!
  const out3 = await runners.runRunnerProfile(profile3, { from: nameFilter, argvOverride: [...profile3.command, '-t', 'nothing here'], selectionLabel: 'rerun-failed' })
  expectNoMatch('A3 a name filter that matched no test (exit 0, three pending) — the rerun-failed road', out3, 'rerun-failed', 'Tests:       3 skipped, 3 total', 3)
  check('A3 the rerun note names the remedy', out3.state === 'ok' && (out3.record.verdictNote ?? '').includes('run the full profile to refresh its case names'), out3.state === 'ok' ? out3.record.verdictNote ?? '' : out3.state)

  section('A4. the Test tool road: the outcome word is no-change (not failed), the result reads the no-match line first, and the effect carries the same word')
  const result = await runWithCwdOverride(withReport, () => TestTool.call({ op: 'run', node: 'math ops' } as never, { getAppState: () => ({}) } as never)) as { data: { outcome: string; result: string; record?: TestRunRecord }; effect: { outcome: string } }
  check('A4 data.outcome is no-change', result.data.outcome === 'no-change', result.data.outcome)
  check('A4 effect.outcome is no-change (the tool_result is not an error)', result.effect.outcome === 'no-change', result.effect.outcome)
  const lines = result.data.result.split('\n')
  check('A4 the second line is the no-match line with the runner\'s words', lines[1] === `jest no test matched nodes:math ops — Pattern: math ops - 0 matches · No tests found, exiting with code 1`, lines[1] ?? '')
  check('A4 the third line carries the zero counts', (lines[2] ?? '').startsWith('counts: 0 passed · 0 failed · 0 skipped · 0 errored'), lines[2] ?? '')
  check('A4 the result never says "1 failed"', !result.data.result.includes('1 failed'), result.data.result)
  await import('../../src/services/resources/adapters/test.ts')
  const { resolveResource } = await import('../../src/services/resources/registry.ts')
  const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
  const inspected = await runWithCwdOverride(withReport, () => resolveResource(`mercury://test/run/${result.data.record!.id}`, { owner: makeOwnerKey({ workspace: withReport, sessionId: 'no-match-proof', lane: 'main' }), cwd: withReport }))
  check('A4 the Inspect view of the record says no test matched', inspected.state === 'ok' && inspected.resource.summary.includes('no test matched'), JSON.stringify(inspected).slice(0, 200))
  await expectNoMatchRerun('A5 jest', withReport, result.data.record!.id, 'nodes:math ops')
  for (const root of [withReport, noReport, nameFilter]) rmSync(root, { recursive: true, force: true })
}

section('B. vitest — the same shapes (recorded vitest 3.2.7)')
{
  const noFile = standInProject('vitest', { exitCode: 1, report: fixture('vitest-no-match-report.json'), stdout: fixture('vitest-no-match.txt') })
  const profile = runners.discoverRunnerProfiles(noFile).profiles.find(p => p.runner === 'vitest')!
  const out = await runners.runRunnerProfile(profile, { from: noFile, selection: 'math ops', selectionKind: 'node', selectionLabel: 'nodes:math ops' })
  expectNoMatch('B1 vitest: no test file matched the filter', out, 'nodes:math ops', 'No test files found, exiting with code 1 · filter: math ops')
  const nameFilter = standInProject('vitest', { exitCode: 0, report: fixture('vitest-name-filter-no-match-report.json'), stdout: fixture('vitest-name-filter-no-match.txt') })
  const profile2 = runners.discoverRunnerProfiles(nameFilter).profiles.find(p => p.runner === 'vitest')!
  const out2 = await runners.runRunnerProfile(profile2, { from: nameFilter, argvOverride: [...profile2.command, '-t', 'nothing here'], selectionLabel: 'rerun-failed' })
  expectNoMatch('B2 vitest: a name filter that matched no test (three skipped, exit 0)', out2, 'rerun-failed', 'Tests  3 skipped (3)', 3)
  const result = await runWithCwdOverride(noFile, () => TestTool.call({ op: 'run', node: 'math ops' } as never, { getAppState: () => ({}) } as never)) as { data: { outcome: string; result: string } }
  check('B3 the Test tool reports vitest\'s no-match as no-change with the runner\'s words', result.data.outcome === 'no-change' && result.data.result.includes('vitest no test matched nodes:math ops — No test files found'), `${result.data.outcome} ${result.data.result.split('\n')[1] ?? ''}`)
  await expectNoMatchRerun('B4 vitest', noFile, (result as { data: { record?: TestRunRecord } }).data.record!.id, 'nodes:math ops')
  for (const root of [noFile, nameFilter]) rmSync(root, { recursive: true, force: true })
}

section('C. a run that fails for a real reason is still a failure: a crashed suite, a broken file and a genuine failing test keep their counts')
{
  const broken = standInProject('jest', { exitCode: 1, report: fixture('jest-broken-file.json'), stdout: 'Test suite failed to run\n' })
  const profile = runners.discoverRunnerProfiles(broken).profiles.find(p => p.runner === 'jest')!
  const out = await runners.runRunnerProfile(profile, { from: broken, selection: 'math ops', selectionKind: 'node', selectionLabel: 'nodes:math ops' })
  check('C1 a file that failed to load stays errored, never a no-match', out.state === 'ok' && out.record.verdict === undefined && out.record.counts.errored === 1, out.state === 'ok' ? JSON.stringify({ verdict: out.record.verdict, counts: out.record.counts }) : out.state)
  const failing = standInProject('jest', { exitCode: 1, report: fixture('jest-report.json'), stdout: fixture('jest-prose.txt') })
  const profile2 = runners.discoverRunnerProfiles(failing).profiles.find(p => p.runner === 'jest')!
  const out2 = await runners.runRunnerProfile(profile2, { from: failing })
  check('C2 a real failing test keeps 1 failed and no no-match word', out2.state === 'ok' && out2.record.verdict === undefined && out2.record.counts.failed === 1, out2.state === 'ok' ? JSON.stringify({ verdict: out2.record.verdict, counts: out2.record.counts }) : out2.state)
  const crashed = standInProject('jest', { exitCode: 1, report: null, stdout: '● Validation Error:\n\n  Module ./setup.js in the setupFiles option was not found.\n' })
  const profile3 = runners.discoverRunnerProfiles(crashed).profiles.find(p => p.runner === 'jest')!
  const out3 = await runners.runRunnerProfile(profile3, { from: crashed, selection: 'math ops', selectionKind: 'node', selectionLabel: 'nodes:math ops' })
  check('C3 a runner that crashed before running (no report, no no-match words) keeps the exit-state verdict: 1 failed, counts not parsed', out3.state === 'ok' && out3.record.verdict === undefined && out3.record.counts.failed === 1 && (out3.record.verdictNote ?? '').includes('counts not parsed'), out3.state === 'ok' ? JSON.stringify({ verdict: out3.record.verdict, counts: out3.record.counts, note: out3.record.verdictNote }) : out3.state)
  for (const root of [broken, failing, crashed]) rmSync(root, { recursive: true, force: true })
}

section('D. node --test, live: a name pattern that matches nothing is no-match with zero counts (node counts the file as one passing test; the plan 1..0 says no case ran), and a missing file is no-match with node\'s own words')
{
  const root = scratch('node-test')
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true }) + '\n')
  writeFileSync(path.join(root, 'sum.test.mjs'), 'import { test } from "node:test"\nimport assert from "node:assert"\ntest("adds", () => { assert.equal(2 + 3, 5) })\ntest("adds negatives", () => { assert.equal(-2 + -3, -5) })\n')
  const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'node-test' && p.kind === 'test')!
  const whole = await runners.runRunnerProfile(profile, { from: root })
  check('D0 the whole file runs two passing tests (the control)', whole.state === 'ok' && whole.record.counts.passed === 2 && whole.record.verdict === undefined, whole.state === 'ok' ? JSON.stringify(whole.record.counts) : whole.state)
  const out = await runners.runRunnerProfile(profile, { from: root, selection: 'nothing here', selectionKind: 'node', selectionLabel: 'nodes:nothing here' })
  expectNoMatch('D1 node --test --test-name-pattern "nothing here"', out, 'nodes:nothing here', '1..0')
  const missing = await runners.runRunnerProfile(profile, { from: root, selection: 'nothing-here.test.mjs', selectionKind: 'path', selectionLabel: 'file:nothing-here.test.mjs' })
  expectNoMatch('D2 node --test on a file that does not exist', missing, 'file:nothing-here.test.mjs', "Could not find 'nothing-here.test.mjs'")
  if (missing.state === 'ok') await expectNoMatchRerun('D3 node --test', root, missing.record.id, 'file:nothing-here.test.mjs')
  rmSync(root, { recursive: true, force: true })
}

section('E. go test, live when the toolchain is on PATH: -run with no match is no-match with go\'s own warning')
if (onPath('go')) {
  const root = scratch('go')
  writeFileSync(path.join(root, 'go.mod'), 'module example.com/fixture\n\ngo 1.22\n')
  writeFileSync(path.join(root, 'sum.go'), 'package fixture\n\nfunc Sum(a, b int) int { return a + b }\n')
  writeFileSync(path.join(root, 'sum_test.go'), 'package fixture\n\nimport "testing"\n\nfunc TestSum(t *testing.T) { if Sum(2, 3) != 5 { t.Fatal("bad") } }\n')
  const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'go' && p.kind === 'test')!
  const out = await runners.runRunnerProfile(profile, { from: root, selection: 'NothingHere', selectionKind: 'node', selectionLabel: 'nodes:NothingHere', env: { GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local' } })
  expectNoMatch('E1 go test -run NothingHere', out, 'nodes:NothingHere', 'testing: warning: no tests to run')
  rmSync(root, { recursive: true, force: true })
} else {
  console.log('  [SKIP — LOUD] no go on PATH — the recorded go-test-no-match.jsonl below is the evidence for this runner')
}
{
  const { parseGoTestJson } = await import('../../src/services/ide/runnerReporters.ts')
  const read = parseGoTestJson(fixture('go-test-no-match.jsonl'), FIXTURE_ROOT)
  check('E2 the recorded go no-match reporter reads 0/0/0/0 with no failure rows', read !== null && zero(read.counts) && read.failures.length === 0, JSON.stringify(read))
}

section('F. cargo test, live when the toolchain is on PATH: a filter that matches nothing is no-match with cargo\'s own summary line')
if (onPath('cargo')) {
  const root = scratch('cargo')
  writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n')
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'src', 'lib.rs'), 'pub fn sum(a: i32, b: i32) -> i32 { a + b }\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn adds() { assert_eq!(sum(2, 3), 5); }\n}\n')
  const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'cargo' && p.kind === 'test')!
  const out = await runners.runRunnerProfile(profile, { from: root, selection: 'nothing_here', selectionKind: 'node', selectionLabel: 'nodes:nothing_here', timeoutMs: 240_000 })
  expectNoMatch('F1 cargo test nothing_here', out, 'nodes:nothing_here', '0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out')
  rmSync(root, { recursive: true, force: true })
} else {
  console.log('  [SKIP — LOUD] no cargo on PATH — the recorded cargo-no-match.txt is the evidence for this runner')
}

section('G. the python lane: pytest\'s three no-match shapes (a node, a file, a -k filter) when the pinned interpreter carries pytest')
{
  const SYS_PY = process.platform === 'win32' ? 'python' : '/usr/bin/python3'
  process.env.MERCURY_PYTHON ??= SYS_PY
  const proj = scratch('py')
  writeFileSync(path.join(proj, 'pyproject.toml'), '[project]\nname = "fixture"\nversion = "0.0.1"\n')
  mkdirSync(path.join(proj, 'tests'))
  writeFileSync(path.join(proj, 'tests', '__init__.py'), '')
  writeFileSync(path.join(proj, 'tests', 'test_sum.py'), 'import unittest\n\nclass TestSum(unittest.TestCase):\n    def test_adds(self):\n        self.assertEqual(2 + 3, 5)\n')
  const probe = pythonTests.probePytest(proj)
  if (probe.available) {
    const node = await pythonTests.runPythonTests({ from: proj, framework: 'pytest', selection: ['tests/test_sum.py::TestSum::test_nothing'], selectionLabel: 'nodes:tests/test_sum.py::TestSum::test_nothing' })
    check('G1 a node that does not exist is no-match with pytest\'s "(no match in any of …)"', node.state === 'ok' && node.record.verdict === 'no-match' && zero(node.record.counts) && (node.record.verdictNote ?? '').startsWith('no test matched nodes:tests/test_sum.py::TestSum::test_nothing — (no match in any of'), JSON.stringify(node).slice(0, 300))
    const file = await pythonTests.runPythonTests({ from: proj, framework: 'pytest', selection: ['tests/nothing_here.py'], selectionLabel: 'file:tests/nothing_here.py' })
    check('G2 a file that does not exist is no-match with pytest\'s "file or directory not found"', file.state === 'ok' && file.record.verdict === 'no-match' && (file.record.verdictNote ?? '').includes('ERROR: file or directory not found: tests/nothing_here.py'), JSON.stringify(file).slice(0, 300))
    const filter = await pythonTests.runPythonTests({ from: proj, framework: 'pytest', selection: ['-k', 'nothing_here'], selectionLabel: 'nodes:-k nothing_here' })
    check('G3 a -k filter that deselects everything is no-match (exit 5) with the deselected line', filter.state === 'ok' && filter.record.verdict === 'no-match' && filter.record.exitCode === 5 && (filter.record.verdictNote ?? '').includes('1 deselected in'), JSON.stringify(filter).slice(0, 300))
    const result = await runWithCwdOverride(proj, () => TestTool.call({ op: 'run', framework: 'pytest', node: 'tests/test_sum.py::TestSum::test_nothing' } as never, { getAppState: () => ({}) } as never)) as { data: { outcome: string; result: string } }
    check('G4 the Test tool reports the pytest no-match as no-change', result.data.outcome === 'no-change' && result.data.result.includes('pytest no test matched nodes:tests/test_sum.py::TestSum::test_nothing'), `${result.data.outcome} ${result.data.result.split('\n')[1] ?? ''}`)
    await expectNoMatchRerun('G4b pytest', proj, (result as { data: { record?: TestRunRecord } }).data.record!.id, 'nodes:tests/test_sum.py::TestSum::test_nothing')
    const whole = await pythonTests.runPythonTests({ from: proj, framework: 'pytest', selectionLabel: 'all' })
    check('G5 the whole suite still runs its one test (the control)', whole.state === 'ok' && whole.record.verdict === undefined && whole.record.counts.passed === 1, JSON.stringify(whole).slice(0, 200))
  } else {
    console.log(`  [SKIP — LOUD] pytest arm: ${probe.detail} — point MERCURY_PYTHON at an interpreter that carries pytest to run this leg`)
  }
  const unit = await pythonTests.runPythonTests({ from: proj, framework: 'unittest', selection: ['tests.test_sum.TestSum.test_nothing'], selectionLabel: 'nodes:tests.test_sum.TestSum.test_nothing' })
  check('G6 unittest takes the same law: a node the loader cannot find is no-match with the loader\'s AttributeError as the words, zero counts, no _FailedTest row (prove-unittest-no-match.ts carries the shapes)', unit.state === 'ok' && unit.record.verdict === 'no-match' && zero(unit.record.counts) && unit.record.cases.length === 0 && (unit.record.verdictNote ?? '').startsWith("no test matched nodes:tests.test_sum.TestSum.test_nothing — AttributeError: type object 'TestSum' has no attribute 'test_nothing'"), JSON.stringify(unit).slice(0, 300))
  rmSync(proj, { recursive: true, force: true })
}

clearTimeout(guard)
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'runner-no-match: ALL LAWS HOLD' : `runner-no-match: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
