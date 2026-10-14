#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'runner-counts-home-'))
process.env.MERCURY_BARE = '1'

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'runners')
const FIXTURE_ROOT = '/work/project'

const reporters = await import('../../src/services/ide/runnerReporters.ts')
const runners = await import('../../src/services/ide/projectRunners.ts')
const { latestRun } = await import('../../src/services/ide/pythonTests.ts')
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
  console.log('\nTIMEOUT — runner counts proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')
const scratch = (label: string): string => mkdtempSync(path.join(tmpdir(), `runner-counts-${label}-`))

type StandIn = { exitCode: number; report: string | null; stdout: string }

function standInProject(runner: 'vitest' | 'jest', behaviour: StandIn): { root: string; argvFile: string; writtenFile: string } {
  const root = scratch(runner)
  const argvFile = path.join(root, 'argv.json')
  const writtenFile = path.join(root, 'written.txt')
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, devDependencies: { [runner]: '*' } }) + '\n')
  writeFileSync(path.join(root, 'bun.lock'), '{}\n')
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'src', runner === 'vitest' ? 'calc.test.mjs' : 'calc.jest.test.cjs'), '\n')
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  const bin = path.join(root, 'node_modules', '.bin', runner)
  const report = behaviour.report === null ? null : behaviour.report.split(FIXTURE_ROOT).join(root)
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))`,
      `const out = process.argv.slice(2).find(a => a.startsWith('--outputFile='))`,
      `const report = ${JSON.stringify(report)}`,
      `if (out && report !== null) { require('fs').writeFileSync(out.slice('--outputFile='.length), report); require('fs').writeFileSync(${JSON.stringify(writtenFile)}, out.slice('--outputFile='.length)) }`,
      `process.stdout.write(${JSON.stringify(behaviour.stdout)})`,
      `process.exit(${behaviour.exitCode})`,
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return { root, argvFile, writtenFile }
}

section('A. the recorded vitest reporter through the real parser (vitest 3.2.7, recorded; see fixtures/runners/RECORDED.txt)')
{
  const read = reporters.parseJsonReporter(fixture('vitest-report.json'), FIXTURE_ROOT)
  check('A1 counts come from the reporter: 1 passed · 1 failed · 1 skipped · 0 errored', read !== null && JSON.stringify(read.counts) === JSON.stringify({ passed: 1, failed: 1, skipped: 1, errored: 0 }), JSON.stringify(read?.counts))
  const failing = read?.cases.find(c => c.outcome === 'failed')
  check('A2 the failing case carries its full name, file, line and message', failing?.id === 'calc adds two numbers' && failing.file === 'src/calc.test.mjs' && failing.line === 8 && (failing.message ?? '').includes('expected -1 to be 5'), JSON.stringify(failing))
  check('A3 failures[] is the rerun selection by full name', JSON.stringify(read?.failures) === JSON.stringify(['calc adds two numbers']), JSON.stringify(read?.failures))
  check('A4 passed and skipped cases leave no failure rows', read?.cases.length === 1, String(read?.cases.length))
  const broken = reporters.parseJsonReporter(fixture('vitest-broken-file.json'), FIXTURE_ROOT)
  check('A5 a file that failed to load is ERRORED, never a green run', broken !== null && JSON.stringify(broken.counts) === JSON.stringify({ passed: 0, failed: 0, skipped: 0, errored: 1 }) && broken.cases[0]?.outcome === 'errored' && broken.cases[0]?.id === 'src/broken.test.mjs' && (broken.cases[0]?.message ?? '').includes('Cannot find module'), JSON.stringify(broken))
  check('A6 unparseable text is null, never invented counts', reporters.parseJsonReporter('not json', FIXTURE_ROOT) === null && reporters.parseJsonReporter('[1,2]', FIXTURE_ROOT) === null && reporters.parseJsonReporter('{"hello":1}', FIXTURE_ROOT) === null)
}

section('B. the argv the profile builds carries the machine reporter')
{
  const { root } = standInProject('vitest', { exitCode: 0, report: null, stdout: '' })
  const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'vitest' && p.kind === 'test')
  check('B1 vitest run --reporter=default --reporter=json (the default reporter keeps the prose, the json one feeds the counts)', JSON.stringify(profile?.command.slice(1)) === JSON.stringify(['run', '--reporter=default', '--reporter=json']), JSON.stringify(profile?.command))
  const fileFlag = (runners as { reporterFileFlag?: (runner: string) => string | null }).reporterFileFlag ?? (() => 'absent on this tree')
  check('B2 the per-run output file rides --outputFile=', fileFlag('vitest') === '--outputFile=', String(fileFlag('vitest')))
  check('B3 node-test and cargo keep their own parsers (no output file)', fileFlag('node-test') === null && fileFlag('cargo') === null)
  rmSync(root, { recursive: true, force: true })
}

section('C. the run road: the reporter file is written by the runner, read, parsed and removed')
{
  const { root, argvFile, writtenFile } = standInProject('vitest', { exitCode: 1, report: fixture('vitest-report.json'), stdout: fixture('vitest-prose.txt') })
  const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'vitest' && p.kind === 'test')!
  const run = await runners.runRunnerProfile(profile, { from: root })
  check('C1 run lands', run.state === 'ok', JSON.stringify(run).slice(0, 200))
  if (run.state === 'ok') {
    const r = run.record
    check('C2 counts are the reporter\'s: 1 passed · 1 failed · 1 skipped · 0 errored', JSON.stringify(r.counts) === JSON.stringify({ passed: 1, failed: 1, skipped: 1, errored: 0 }), JSON.stringify(r.counts))
    check('C3 no "counts not parsed" note on a parsed run', !(r.verdictNote ?? '').includes('counts not parsed'), r.verdictNote ?? '')
    const failing = r.cases.find(c => c.outcome === 'failed')
    check('C4 the failing case is typed: full name · src/calc.test.mjs:8 · the assertion message', failing?.id === 'calc adds two numbers' && failing.file === 'src/calc.test.mjs' && failing.line === 8 && (failing.message ?? '').includes('expected -1 to be 5'), JSON.stringify(failing))
    check('C5 failures[] carries the full name vitest\'s own -t matches', JSON.stringify(r.failures) === JSON.stringify(['calc adds two numbers']), JSON.stringify(r.failures))
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[]
    const outputFlag = argv.find(a => a.startsWith('--outputFile='))
    check('C6 the runner received --outputFile=<a scratch path> after the reporter flags', argv[0] === 'run' && argv.includes('--reporter=json') && outputFlag !== undefined, JSON.stringify(argv))
    const written = existsSync(writtenFile) ? readFileSync(writtenFile, 'utf8') : ''
    check('C7 the report file is removed after the read', written.length > 0 && !existsSync(written), written)
    check('C8 the record persisted in the one store', runWithCwdOverride(root, () => latestRun(root))?.framework === 'vitest')
    const rerun = await runners.rerunRunnerFailures(r, { from: root })
    const rerunArgv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[]
    check('C9 rerunFailed selects by full name with the reporter flags still present', rerun.state === 'ok' && rerunArgv.includes('-t') && rerunArgv[rerunArgv.indexOf('-t') + 1] === 'calc adds two numbers' && rerunArgv.includes('--reporter=json') && rerunArgv.some(a => a.startsWith('--outputFile=')), JSON.stringify(rerunArgv))
    const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
    const report = (await runWithCwdOverride(root, () => TestTool.call({ op: 'report' } as never, { getAppState: () => ({}) } as never))) as { data: { result: string } }
    check('C10 the Test tool\'s report reads the counts and the typed failure', report.data.result.includes('1 passed · 1 failed · 1 skipped · 0 errored') && report.data.result.includes('calc adds two numbers (src/calc.test.mjs:8)') && !report.data.result.includes('counts not parsed'), report.data.result.split('\n').slice(0, 4).join(' | '))
  }
  rmSync(root, { recursive: true, force: true })
}

section('C\'. the honest edges: exit disagreements and an unparseable reporter')
{
  const greenObject = JSON.parse(fixture('vitest-report.json')) as { numFailedTests: number; numPassedTests: number; testResults: Array<{ status: string; assertionResults: Array<{ status: string; failureMessages: string[] }> }> }
  greenObject.numFailedTests = 0
  greenObject.numPassedTests = 2
  for (const file of greenObject.testResults) {
    file.status = 'passed'
    for (const a of file.assertionResults) if (a.status === 'failed') { a.status = 'passed'; a.failureMessages = [] }
  }
  const green = standInProject('vitest', { exitCode: 1, report: JSON.stringify(greenObject), stdout: '' })
  const gp = runners.discoverRunnerProfiles(green.root).profiles.find(p => p.runner === 'vitest' && p.kind === 'test')!
  const greenRun = await runners.runRunnerProfile(gp, { from: green.root })
  check('C11 a non-zero exit with a clean report is NOT green and says why', greenRun.state === 'ok' && greenRun.record.counts.failed === 0 && (greenRun.record.verdictNote ?? '').includes('exited 1 with no failing case in its report'), JSON.stringify(greenRun.state === 'ok' ? greenRun.record.verdictNote : greenRun))
  rmSync(green.root, { recursive: true, force: true })

  const liar = standInProject('vitest', { exitCode: 0, report: fixture('vitest-report.json'), stdout: '' })
  const lp = runners.discoverRunnerProfiles(liar.root).profiles.find(p => p.runner === 'vitest' && p.kind === 'test')!
  const liarRun = await runners.runRunnerProfile(lp, { from: liar.root })
  check('C12 exit 0 with a failing report is FAILED and the disagreement is recorded', liarRun.state === 'ok' && liarRun.record.counts.failed === 1 && (liarRun.record.verdictNote ?? '').includes('disagreed'), JSON.stringify(liarRun.state === 'ok' ? liarRun.record.verdictNote : liarRun))
  rmSync(liar.root, { recursive: true, force: true })

  const garbage = standInProject('vitest', { exitCode: 1, report: 'this is not a report', stdout: fixture('vitest-prose.txt') })
  const gpp = runners.discoverRunnerProfiles(garbage.root).profiles.find(p => p.runner === 'vitest' && p.kind === 'test')!
  const garbageRun = await runners.runRunnerProfile(gpp, { from: garbage.root })
  check('C13 an unparseable reporter keeps the honest note and the exit-code verdict, never invented counts', garbageRun.state === 'ok' && (garbageRun.record.verdictNote ?? '').includes('counts not parsed for vitest') && JSON.stringify(garbageRun.record.counts) === JSON.stringify({ passed: 0, failed: 1, skipped: 0, errored: 0 }), JSON.stringify(garbageRun.state === 'ok' ? garbageRun.record : garbageRun).slice(0, 200))
  check('C14 …and the prose fallback still names the failing case from the default reporter\'s output', garbageRun.state === 'ok' && garbageRun.record.cases.some(c => c.id === 'calc > adds two numbers' && c.file === 'src/calc.test.mjs'), JSON.stringify(garbageRun.state === 'ok' ? garbageRun.record.cases : []))
  rmSync(garbage.root, { recursive: true, force: true })
}

section('D. the live leg — a real vitest when MERCURY_PROOF_RUNNER_MODULES names a node_modules that carries it')
{
  const modules = process.env.MERCURY_PROOF_RUNNER_MODULES
  const vitestBin = modules ? path.join(modules, '.bin', 'vitest') : ''
  if (!modules || !existsSync(vitestBin)) {
    console.log(`  [SKIP — LOUD] no vitest on this machine (${modules ? `${vitestBin} absent` : 'MERCURY_PROOF_RUNNER_MODULES unset'}) — the recorded reporter above is the evidence; point MERCURY_PROOF_RUNNER_MODULES at a node_modules carrying vitest to run this leg`)
  } else {
    const root = scratch('live-vitest')
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'live', private: true, type: 'module', devDependencies: { vitest: '*' } }) + '\n')
    writeFileSync(path.join(root, 'bun.lock'), '{}\n')
    symlinkSync(modules, path.join(root, 'node_modules'))
    mkdirSync(path.join(root, 'src'))
    writeFileSync(
      path.join(root, 'src', 'calc.test.mjs'),
      [
        "import { describe, it, expect } from 'vitest'",
        'function add(a, b) { return a - b }',
        "describe('calc', () => {",
        "  it('adds two numbers', () => { expect(add(2, 3)).toBe(5) })",
        "  it('keeps zero', () => { expect(add(0, 0)).toBe(0) })",
        "  it.skip('divides later', () => {})",
        '})',
        '',
      ].join('\n'),
    )
    const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'vitest' && p.kind === 'test')!
    const live = await runners.runRunnerProfile(profile, { from: root, env: { CI: '1' } })
    check('D1 live vitest: 1 passed · 1 failed · 1 skipped from its own reporter', live.state === 'ok' && JSON.stringify(live.record.counts) === JSON.stringify({ passed: 1, failed: 1, skipped: 1, errored: 0 }), JSON.stringify(live.state === 'ok' ? live.record.counts : live))
    check('D2 live vitest: the failing case is typed with its file and line', live.state === 'ok' && live.record.cases.some(c => c.id === 'calc adds two numbers' && c.file === 'src/calc.test.mjs' && c.line === 4), JSON.stringify(live.state === 'ok' ? live.record.cases : []))
    if (live.state === 'ok') {
      const rerun = await runners.rerunRunnerFailures(live.record, { from: root })
      check('D3 live rerunFailed runs exactly the failure (the other two skipped by -t)', rerun.state === 'ok' && rerun.record.counts.failed === 1 && rerun.record.counts.passed === 0 && rerun.record.counts.skipped === 2, JSON.stringify(rerun.state === 'ok' ? rerun.record.counts : rerun))
    }
    rmSync(root, { recursive: true, force: true })
  }
}

section('E. the recorded jest reporter through the same parser (jest 29.7.0, recorded)')
{
  const read = reporters.parseJsonReporter(fixture('jest-report.json'), FIXTURE_ROOT)
  check('E1 counts: 1 passed · 1 failed · 1 skipped (jest spells a skipped test "pending") · 0 errored', read !== null && JSON.stringify(read.counts) === JSON.stringify({ passed: 1, failed: 1, skipped: 1, errored: 0 }), JSON.stringify(read?.counts))
  const failing = read?.cases.find(c => c.outcome === 'failed')
  check('E2 the failing case: full name · src/calc.jest.test.cjs:6 · the expect message', failing?.id === 'calc adds two numbers' && failing.file === 'src/calc.jest.test.cjs' && failing.line === 6 && (failing.message ?? '').includes('expect(received).toBe(expected)') && (failing.message ?? '').includes('Received: -1'), JSON.stringify(failing))
  check('E3 failures[] is the -t selection by full name', JSON.stringify(read?.failures) === JSON.stringify(['calc adds two numbers']), JSON.stringify(read?.failures))
  const broken = reporters.parseJsonReporter(fixture('jest-broken-file.json'), FIXTURE_ROOT)
  check('E4 a suite that failed to run (numRuntimeErrorTestSuites) is ERRORED with its message', broken !== null && JSON.stringify(broken.counts) === JSON.stringify({ passed: 0, failed: 0, skipped: 0, errored: 1 }) && broken.cases[0]?.outcome === 'errored' && broken.cases[0]?.id === 'src/broken.jest.test.cjs' && (broken.cases[0]?.message ?? '').includes('Cannot find module'), JSON.stringify(broken))
}

section('F. jest: the argv, the run road and the rerun')
{
  const { root, argvFile, writtenFile } = standInProject('jest', { exitCode: 1, report: fixture('jest-report.json'), stdout: fixture('jest-prose.txt') })
  const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'jest' && p.kind === 'test')
  check('F1 the jest profile runs jest --json', JSON.stringify(profile?.command.slice(1)) === JSON.stringify(['--json']), JSON.stringify(profile?.command))
  const fileFlag = (runners as { reporterFileFlag?: (runner: string) => string | null }).reporterFileFlag ?? (() => 'absent on this tree')
  check('F2 the per-run output file rides --outputFile=', fileFlag('jest') === '--outputFile=', String(fileFlag('jest')))
  const run = profile ? await runners.runRunnerProfile(profile, { from: root }) : null
  check('F3 counts are the reporter\'s and no "counts not parsed" note', run?.state === 'ok' && JSON.stringify(run.record.counts) === JSON.stringify({ passed: 1, failed: 1, skipped: 1, errored: 0 }) && !(run.record.verdictNote ?? '').includes('counts not parsed'), JSON.stringify(run?.state === 'ok' ? { counts: run.record.counts, note: run.record.verdictNote } : run))
  const failing = run?.state === 'ok' ? run.record.cases.find(c => c.outcome === 'failed') : undefined
  check('F4 the failing case is typed: full name · src/calc.jest.test.cjs:6', failing?.id === 'calc adds two numbers' && failing.file === 'src/calc.jest.test.cjs' && failing.line === 6, JSON.stringify(failing))
  const argv = existsSync(argvFile) ? (JSON.parse(readFileSync(argvFile, 'utf8')) as string[]) : []
  check('F5 jest received --json and --outputFile=<a scratch path>', argv.includes('--json') && argv.some(a => a.startsWith('--outputFile=')), JSON.stringify(argv))
  const written = existsSync(writtenFile) ? readFileSync(writtenFile, 'utf8') : ''
  check('F6 the report file is removed after the read', written.length > 0 && !existsSync(written), written)
  if (run?.state === 'ok') {
    const rerun = await runners.rerunRunnerFailures(run.record, { from: root })
    const rerunArgv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[]
    check('F7 rerunFailed selects by full name with --json still present', rerun.state === 'ok' && rerunArgv.includes('-t') && rerunArgv[rerunArgv.indexOf('-t') + 1] === 'calc adds two numbers' && rerunArgv.includes('--json'), JSON.stringify(rerunArgv))
  }
  rmSync(root, { recursive: true, force: true })
}

section('G. the live leg — a real jest when MERCURY_PROOF_RUNNER_MODULES carries it')
{
  const modules = process.env.MERCURY_PROOF_RUNNER_MODULES
  const jestBin = modules ? path.join(modules, '.bin', 'jest') : ''
  if (!modules || !existsSync(jestBin)) {
    console.log(`  [SKIP — LOUD] no jest on this machine (${modules ? `${jestBin} absent` : 'MERCURY_PROOF_RUNNER_MODULES unset'}) — the recorded reporter above is the evidence`)
  } else {
    const root = scratch('live-jest')
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'live', private: true, devDependencies: { jest: '*' }, jest: { testEnvironment: 'node' } }) + '\n')
    writeFileSync(path.join(root, 'bun.lock'), '{}\n')
    symlinkSync(modules, path.join(root, 'node_modules'))
    mkdirSync(path.join(root, 'src'))
    writeFileSync(
      path.join(root, 'src', 'calc.test.js'),
      [
        'function add(a, b) { return a - b }',
        "describe('calc', () => {",
        "  it('adds two numbers', () => { expect(add(2, 3)).toBe(5) })",
        "  it('keeps zero', () => { expect(add(0, 0)).toBe(0) })",
        "  it.skip('divides later', () => {})",
        '})',
        '',
      ].join('\n'),
    )
    const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'jest' && p.kind === 'test')!
    const live = await runners.runRunnerProfile(profile, { from: root, env: { CI: '1' } })
    check('G1 live jest: 1 passed · 1 failed · 1 skipped from its own reporter', live.state === 'ok' && JSON.stringify(live.record.counts) === JSON.stringify({ passed: 1, failed: 1, skipped: 1, errored: 0 }), JSON.stringify(live.state === 'ok' ? live.record.counts : live))
    check('G2 live jest: the failing case is typed with its file and line', live.state === 'ok' && live.record.cases.some(c => c.id === 'calc adds two numbers' && c.file === 'src/calc.test.js' && c.line === 3), JSON.stringify(live.state === 'ok' ? live.record.cases : []))
    if (live.state === 'ok') {
      const rerun = await runners.rerunRunnerFailures(live.record, { from: root })
      check('G3 live rerunFailed runs exactly the failure', rerun.state === 'ok' && rerun.record.counts.failed === 1 && rerun.record.counts.passed === 0 && rerun.record.counts.skipped === 2, JSON.stringify(rerun.state === 'ok' ? rerun.record.counts : rerun))
    }
    rmSync(root, { recursive: true, force: true })
  }
}

section('H. the go test -json stream through the real parser (written from the test2json format; no Go on the recording machine)')
{
  const parseGo = (reporters as { parseGoTestJson?: (text: string, root: string) => { counts: unknown; failures: string[]; cases: Array<{ id: string; outcome: string; file?: string; line?: number; message?: string }> } | null }).parseGoTestJson
  const read = parseGo ? parseGo(fixture('go-test.jsonl'), FIXTURE_ROOT) : null
  check('H1 counts per test event: 2 passed (TestZero, TestTable/one) · 3 failed (TestAdd, TestTable/two, TestTable) · 1 skipped · 0 errored', read !== null && JSON.stringify(read.counts) === JSON.stringify({ passed: 2, failed: 3, skipped: 1, errored: 0 }), JSON.stringify(read?.counts))
  const add = read?.cases.find(c => c.id === 'TestAdd')
  check('H2 the failing test carries file, line and message from its own output lines', add?.outcome === 'failed' && add.file === 'calc_test.go' && add.line === 12 && add.message === 'add(2, 3) = -1, want 5', JSON.stringify(add))
  const sub = read?.cases.find(c => c.id === 'TestTable/two')
  check('H3 a failing subtest is its own case with its own location', sub?.file === 'calc_test.go' && sub.line === 31 && (sub.message ?? '').includes('case two'), JSON.stringify(sub))
  check('H4 failures[] lists the failing test names in run order (a parent before its subtests, as go test -v prints them)', JSON.stringify(read?.failures) === JSON.stringify(['TestAdd', 'TestTable', 'TestTable/two']), JSON.stringify(read?.failures))
  const pattern = (reporters as { goRunPattern?: (failures: string[]) => string }).goRunPattern
  check('H5 the rerun pattern anchors the TOP-LEVEL names (go -run splits on / per level; a bare alternation would drop a sibling test)', pattern !== undefined && pattern(['TestAdd', 'TestTable/two', 'TestTable']) === '^(TestAdd|TestTable)$', pattern?.(['TestAdd', 'TestTable/two', 'TestTable']))
  const broken = parseGo ? parseGo(fixture('go-test-build-fail.jsonl'), FIXTURE_ROOT) : null
  check('H6 a package that failed to build is ERRORED with the compiler line, never a green run', broken !== null && JSON.stringify(broken.counts) === JSON.stringify({ passed: 0, failed: 0, skipped: 0, errored: 1 }) && broken.cases[0]?.outcome === 'errored' && broken.cases[0]?.id === 'example.com/broken' && broken.cases[0]?.file === './broken_test.go' && broken.cases[0]?.line === 5 && (broken.cases[0]?.message ?? '').includes('undefined: nope'), JSON.stringify(broken))
  check('H7 prose output (no JSON events) is null, never invented counts', parseGo !== undefined && parseGo('--- FAIL: TestAdd (0.00s)\nFAIL\n', FIXTURE_ROOT) === null)
}

section('I. go: the argv, the run road through a stand-in go on a scratch PATH, and the rerun pattern')
{
  const root = scratch('go')
  writeFileSync(path.join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n')
  const binDir = path.join(root, 'bin')
  mkdirSync(binDir)
  const argvFile = path.join(root, 'argv.json')
  const standIn = path.join(binDir, 'go')
  writeFileSync(
    standIn,
    [
      '#!/usr/bin/env node',
      `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))`,
      `process.stdout.write(${JSON.stringify(fixture('go-test.jsonl'))})`,
      'process.exit(1)',
      '',
    ].join('\n'),
  )
  chmodSync(standIn, 0o755)
  const savedPath = process.env.PATH
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`
  try {
    const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'go' && p.kind === 'test')
    check('I1 the go test profile runs go test -json ./...', JSON.stringify(profile?.command) === JSON.stringify(['go', 'test', '-json', './...']) && profile?.availability.state === 'ok', JSON.stringify(profile?.command))
    const run = profile ? await runners.runRunnerProfile(profile, { from: root }) : null
    check('I2 counts come from the stream and no "counts not parsed" note', run?.state === 'ok' && JSON.stringify(run.record.counts) === JSON.stringify({ passed: 2, failed: 3, skipped: 1, errored: 0 }) && !(run.record.verdictNote ?? '').includes('counts not parsed'), JSON.stringify(run?.state === 'ok' ? { counts: run.record.counts, note: run.record.verdictNote } : run))
    check('I3 the failing cases are typed (TestAdd at calc_test.go:12)', run?.state === 'ok' && run.record.cases.some(c => c.id === 'TestAdd' && c.file === 'calc_test.go' && c.line === 12), JSON.stringify(run?.state === 'ok' ? run.record.cases : []))
    if (run?.state === 'ok') {
      const rerun = await runners.rerunRunnerFailures(run.record, { from: root })
      const rerunArgv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[]
      check('I4 rerunFailed runs go test -json -run ^(TestAdd|TestTable)$ ./...', rerun.state === 'ok' && JSON.stringify(rerunArgv) === JSON.stringify(['test', '-json', '-run', '^(TestAdd|TestTable)$', './...']), JSON.stringify(rerunArgv))
    }
    const changed = runners.changedRunnerSelection({ ...profile!, root })
    check('I5 the changed-file focus keeps -json (or declines honestly on a tree without git)', changed.state === 'unavailable' || (changed.argv[0] === 'go' && changed.argv[1] === 'test' && changed.argv[2] === '-json'), JSON.stringify(changed))
  } finally {
    process.env.PATH = savedPath
    rmSync(root, { recursive: true, force: true })
  }
}

section('J. the live leg — a real go toolchain on PATH')
{
  const goBin = (process.env.PATH ?? '').split(path.delimiter).map(d => path.join(d, 'go')).find(p => existsSync(p))
  if (!goBin) {
    console.log('  [SKIP — LOUD] no go on PATH — the stream fixture above is written from the test2json format, not recorded from a live go; install the Go toolchain to run this leg')
  } else {
    const root = scratch('live-go')
    writeFileSync(path.join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.21\n')
    writeFileSync(path.join(root, 'calc.go'), 'package calc\n\nfunc Add(a, b int) int { return a - b }\n')
    writeFileSync(
      path.join(root, 'calc_test.go'),
      [
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
        'func TestZero(t *testing.T) {',
        '\tif Add(0, 0) != 0 {',
        '\t\tt.Fatal("zero")',
        '\t}',
        '}',
        '',
        'func TestDivide(t *testing.T) {',
        '\tt.Skip("not yet")',
        '}',
        '',
      ].join('\n'),
    )
    const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'go' && p.kind === 'test')!
    const live = await runners.runRunnerProfile(profile, { from: root })
    check('J1 live go: 1 passed · 1 failed · 1 skipped from go test -json', live.state === 'ok' && JSON.stringify(live.record.counts) === JSON.stringify({ passed: 1, failed: 1, skipped: 1, errored: 0 }), JSON.stringify(live.state === 'ok' ? { counts: live.record.counts, note: live.record.verdictNote, tail: live.record.outputTail.slice(-3) } : live))
    check('J2 live go: the failing case is typed with calc_test.go:7', live.state === 'ok' && live.record.cases.some(c => c.id === 'TestAdd' && c.file === 'calc_test.go' && c.line === 7), JSON.stringify(live.state === 'ok' ? live.record.cases : []))
    if (live.state === 'ok') {
      const rerun = await runners.rerunRunnerFailures(live.record, { from: root })
      check('J3 live rerunFailed runs exactly TestAdd', rerun.state === 'ok' && rerun.record.counts.failed === 1 && rerun.record.counts.passed === 0 && rerun.record.counts.skipped === 0, JSON.stringify(rerun.state === 'ok' ? rerun.record.counts : rerun))
    }
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('')
if (failures > 0) {
  console.error(`prove-runner-counts: ${failures} RED`)
  process.exit(1)
}
console.log('prove-runner-counts: GREEN')
