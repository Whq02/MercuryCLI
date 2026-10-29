#!/usr/bin/env bun
// gate-watch: src/tools/TestTool/* src/services/ide/projectRunners* src/services/ide/pythonTests* src/services/ide/pythonProject*
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'test-path-project-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_PYTHON = process.env.MERCURY_PROOF_PYTEST_PYTHON || (process.platform === 'win32' ? 'python' : '/usr/bin/python3')
delete process.env.MERCURY_TESTS
delete process.env.MERCURY_HOME

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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — test-path-project proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'runners')
const scratch = mkdtempSync(path.join(tmpdir(), 'test-path-project-'))
const call = (cwd: string, input: Record<string, unknown>): Promise<ToolAnswer> =>
  runWithCwdOverride(cwd, () => TestTool.call(input as never, { getAppState: () => ({}) } as never)) as Promise<ToolAnswer>
const ask = (cwd: string, input: Record<string, unknown>): Promise<{ behavior: string; message?: string }> =>
  runWithCwdOverride(cwd, () => TestTool.checkPermissions(input as never, {} as never)) as Promise<{ behavior: string; message?: string }>
const firstLine = (r: ToolAnswer): string => r.data.result.split('\n')[0] ?? ''
const secondLine = (r: ToolAnswer): string => r.data.result.split('\n')[1] ?? ''

const SUM_TESTS = 'def add(a, b):\n    return a + b\n\ndef test_adds_two():\n    assert add(1, 1) == 2\n\ndef test_adds_three():\n    assert add(1, 2) == 3\n\ndef test_wrong_on_purpose():\n    assert add(2, 2) == 5\n'

function vitestStandIn(root: string): { argvFile: string } {
  mkdirSync(root, { recursive: true })
  const argvFile = path.join(root, 'argv.json')
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: path.basename(root), private: true, devDependencies: { vitest: '*' } }) + '\n')
  writeFileSync(path.join(root, 'bun.lock'), '{}\n')
  mkdirSync(path.join(root, 'src'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'calc.test.mjs'), '\n')
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  const bin = path.join(root, 'node_modules', '.bin', 'vitest')
  const report = readFileSync(path.join(FIXTURES, 'vitest-report.json'), 'utf8').split('/work/project').join(root)
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))`,
      `const out = process.argv.slice(2).find(a => a.startsWith('--outputFile='))`,
      `if (out) require('fs').writeFileSync(out.slice('--outputFile='.length), ${JSON.stringify(report)})`,
      'process.exit(1)',
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return { argvFile }
}
const argvOf = (argvFile: string): string[] => (existsSync(argvFile) ? (JSON.parse(readFileSync(argvFile, 'utf8')) as string[]) : [])
function barePackage(root: string, name: string): void {
  mkdirSync(path.join(root, name), { recursive: true })
  writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name, private: true }) + '\n')
}

section('A. the box\'s shape (F37W-8A-04): the session folder carries no manifest and no test; a vitest project and a bare pytest project live elsewhere — every op with a path reads THAT project, names it, and the session folder\'s own answer stays what it was (RED on the base: discover ignored path and read the session folder; run and framework:"vitest" were anchored to the session folder\'s manifests)')
{
  const session = path.join(scratch, 'session')
  mkdirSync(session)
  const vitest = path.join(scratch, 'elsewhere', '7b1-vitest')
  const { argvFile } = vitestStandIn(vitest)
  const pytest = path.join(scratch, 'elsewhere', '7b1 spaced pytest')
  mkdirSync(pytest, { recursive: true })
  writeFileSync(path.join(pytest, 'test_sum.py'), SUM_TESTS)
  const probe = probePytest(pytest)
  console.log(`  arm: ${probe.detail}`)

  const own = await call(session, { op: 'discover' })
  check('A0 the session folder\'s own discover (no path) reads the session folder: the unittest lane, 0 tests', own.data.result.startsWith('unittest: 0 test(s)') && !own.data.result.includes(' — in '), own.data.result)

  const discover = await call(session, { op: 'discover', path: vitest })
  check('A1 discover with the vitest project\'s path lists ITS profile and names the project it read', firstLine(discover) === `runner profiles (in ${vitest}):` && new RegExp(`^rp-[0-9a-f]{12} \\[vitest/test\\] vitest \\(declared\\) — in ${vitest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(secondLine(discover)) && discover.data.outcome === 'no-change', discover.data.result)
  check('A1 the two discovers differ — the path was read, not the session folder', discover.data.result !== own.data.result, discover.data.result)

  const run = await call(session, { op: 'run', path: vitest })
  check('A2 run with the project\'s path runs vitest IN that project, the whole suite: cwd is the project, the ran: line says where, counts are the reporter\'s', run.data.record?.framework === 'vitest' && run.data.record?.cwd === vitest && firstLine(run).endsWith(` (in ${vitest})`) && secondLine(run).startsWith('vitest all — 1 passed · 1 failed · 1 skipped · 0 errored') && run.data.outcome === 'failed', run.data.result)
  check('A2 the project folder itself is no file selection: vitest received no path argument', !argvOf(argvFile).includes(vitest) && argvOf(argvFile)[0] === 'run', JSON.stringify(argvOf(argvFile)))

  const forced = await call(session, { op: 'run', framework: 'vitest', path: vitest })
  check('A3 framework:"vitest" with the path picks the project\'s vitest profile (the base refused: "no vitest test profile in this project\'s manifests")', forced.data.record?.framework === 'vitest' && forced.data.record?.cwd === vitest && secondLine(forced).startsWith('vitest all — 1 passed · 1 failed'), forced.data.result)

  const file = path.join(vitest, 'src', 'calc.test.mjs')
  const fileRun = await call(session, { op: 'run', path: file })
  check('A4 a file inside the project is the selection, run from the project', fileRun.data.record?.cwd === vitest && argvOf(argvFile).includes(file) && secondLine(fileRun).startsWith(`vitest file:${file} — 1 passed · 1 failed`) && firstLine(fileRun).endsWith(` (in ${vitest})`), fileRun.data.result)

  const report = await call(session, { op: 'report', path: vitest })
  check('A5 report with the path finds the project\'s latest record (the file run), spelled from the session folder with its location', report.data.record?.id === fileRun.data.record?.id && firstLine(report).endsWith(` (in ${vitest})`), report.data.result)
  const byId = await call(session, { op: 'report', path: vitest, runId: run.data.record!.id })
  check('A5 report by id with the path finds the earlier whole-suite record', byId.data.record?.id === run.data.record?.id, byId.data.result)
  const noPath = await call(session, { op: 'report' })
  check('A5 report without a path reads the session folder\'s own store, which holds nothing', noPath.data.result === 'no recorded test runs yet — op:"run" first' && noPath.data.record === undefined, noPath.data.result)

  const rerun = await call(session, { op: 'rerunFailed', path: vitest })
  check('A6 rerunFailed with the path reruns the project\'s recorded failure by name, in the project', rerun.data.record?.selection === 'rerun-failed' && rerun.data.record?.cwd === vitest && argvOf(argvFile).includes('-t') && argvOf(argvFile)[argvOf(argvFile).indexOf('-t') + 1] === '^calc(?: > | )adds two numbers$' && firstLine(rerun).endsWith(` (in ${vitest})`), rerun.data.result)

  const permission = await ask(session, { op: 'run', path: vitest })
  check('A7 the permission ask shows the project\'s own argv and where it will run', permission.behavior === 'passthrough' && (permission.message ?? '').startsWith(`Test run: ${vitest} — will run: ${path.join(vitest, 'node_modules', '.bin', 'vitest')} run --reporter=default --reporter=json (in ${vitest})`), permission.message ?? '')

  const jest = await call(session, { op: 'run', framework: 'jest', path: vitest })
  check('A8 a framework the project does not declare is refused in the project\'s name, with what it does declare', jest.data.result === `no jest test profile in ${vitest}'s manifests — discovered: vitest/test` && jest.data.outcome === 'failed', jest.data.result)

  const pyDiscover = await call(session, { op: 'discover', path: pytest })
  const pyRun = await call(session, { op: 'run', path: pytest })
  const pyFile = await call(session, { op: 'run', path: path.join(pytest, 'test_sum.py') })
  if (probe.available) {
    check('A9 discover with the pytest project\'s path (pytest importable) lists its three nodes and names the project', pyDiscover.data.result.startsWith(`pytest: 3 test(s) — in ${pytest}`) && pyDiscover.data.result.includes('test_sum.py::test_wrong_on_purpose'), pyDiscover.data.result)
    check('A9 run with the pytest project\'s path runs pytest IN the spaced folder: 2 passed · 1 failed', pyRun.data.record?.framework === 'pytest' && pyRun.data.record?.cwd === pytest && secondLine(pyRun).startsWith('pytest all — 2 passed · 1 failed') && firstLine(pyRun).endsWith(` (in ${pytest})`), pyRun.data.result)
    check('A9 a file inside the pytest project is the selection, run from the project (the pytest path case the box saw, unchanged)', pyFile.data.record?.framework === 'pytest' && pyFile.data.record?.cwd === pytest && secondLine(pyFile).startsWith(`pytest file:${path.join(pytest, 'test_sum.py')} — 2 passed · 1 failed`), pyFile.data.result)
  } else {
    check('A9 discover with the pytest project\'s path (pytest absent) reads THAT folder — the unittest lane, 0 collected — names the project and the file it did not collect', pyDiscover.data.result.startsWith(`unittest: 0 test(s) — in ${pytest}\nNOTE: 1 test file(s) not collected (test_sum.py) — the unittest lane collects unittest.TestCase classes from test*.py files only; pytest is not importable for`), pyDiscover.data.result)
    check('A9 run with the pytest project\'s path is the zero-run of THAT folder, never the session folder\'s empty run', pyRun.data.record?.verdict === 'zero-run' && pyRun.data.record?.cwd === pytest && pyRun.data.result.includes('1 test file(s) found (test_sum.py), the unittest lane ran 0') && firstLine(pyRun).endsWith(` (in ${pytest})`), pyRun.data.result)
    check('A9 a file inside the pytest project runs from the project with the file as its selection', pyFile.data.record?.cwd === pytest && pyFile.data.record?.selection === `file:${path.join(pytest, 'test_sum.py')}`, pyFile.data.result)
  }

  const ownAfter = await call(session, { op: 'run' })
  check('A10 the session folder\'s own run (no path) is untouched by the paths read: the no-test words of the session folder, no location suffix', ownAfter.data.record?.cwd === session && secondLine(ownAfter).startsWith('unittest no test ran') && !firstLine(ownAfter).includes(' (in '), ownAfter.data.result)
  rmSync(path.join(scratch, 'elsewhere'), { recursive: true, force: true })
  rmSync(session, { recursive: true, force: true })
}

section('B. a path INSIDE the session project is the selection it always was: no re-anchoring, no location suffix, the session\'s own words')
{
  const project = path.join(scratch, 'own-vitest')
  const { argvFile } = vitestStandIn(project)
  const relFile = path.join('src', 'calc.test.mjs')
  const run = await call(project, { op: 'run', path: relFile })
  check('B1 a relative file inside the project is passed to the runner as the absolute file, from the project', run.data.record?.cwd === project && argvOf(argvFile).includes(path.join(project, relFile)) && secondLine(run).startsWith(`vitest file:${relFile} — 1 passed · 1 failed`) && !firstLine(run).includes(' (in '), run.data.result)
  const discover = await call(project, { op: 'discover', path: 'src' })
  check('B1 discover with a folder inside the project keeps the manifest-driven words', firstLine(discover) === 'runner profiles (manifest-driven):' && !discover.data.result.includes(' — in '), discover.data.result)
  const sub = path.join(project, 'src')
  const fromSub = await call(sub, { op: 'run', path: path.join(project, 'src', 'calc.test.mjs') })
  check('B2 from a sub-folder of the project, a file elsewhere in the SAME project is still the project\'s own selection (the manifest above both decides)', fromSub.data.record?.cwd === project && argvOf(argvFile).includes(path.join(project, 'src', 'calc.test.mjs')) && secondLine(fromSub).startsWith('vitest file:'), fromSub.data.result)
  const report = await call(project, { op: 'report' })
  check('B3 report without a path reads the project\'s own store', report.data.record?.id === fromSub.data.record?.id, report.data.result)
  rmSync(project, { recursive: true, force: true })
}

section('C. a path to a folder elsewhere whose manifests sit one level down: the sub-package words name THAT folder, and a framework no package declares is refused in its name')
{
  const session = path.join(scratch, 'session-c')
  mkdirSync(session)
  const other = path.join(scratch, 'elsewhere-c', 'mono')
  barePackage(other, 'package1')
  barePackage(other, 'package2')
  const words = `${other} declares its manifests one level down — package1/ (package.json, no test runner declared), package2/ (package.json, no test runner declared) — pass framework: to pick one, or run from the package`
  const run = await call(session, { op: 'run', path: other })
  check('C1 run names the folder read and its packages, runs nothing', run.data.result === words && run.data.outcome === 'no-change' && run.data.record === undefined, run.data.result)
  const discover = await call(session, { op: 'discover', path: other })
  check('C1 discover says the same', discover.data.result === words, discover.data.result)
  const debug = await call(session, { op: 'debug', node: 'x', path: other })
  check('C1 debug says the same', debug.data.result === words, debug.data.result)
  const vitest = await call(session, { op: 'run', framework: 'vitest', path: other })
  check('C2 framework:"vitest" is refused in the folder\'s name with what the packages declare', vitest.data.result === `no vitest test profile in ${other}'s manifests — one level down: package1/ (package.json, no test runner declared), package2/ (package.json, no test runner declared)` && vitest.data.outcome === 'failed', vitest.data.result)
  const permission = await ask(session, { op: 'run', path: other })
  check('C3 the permission ask names the folder and runs nothing', permission.behavior === 'passthrough' && (permission.message ?? '').includes(`no single test runner at ${other}`), permission.message ?? '')
  rmSync(path.join(scratch, 'elsewhere-c'), { recursive: true, force: true })
  rmSync(session, { recursive: true, force: true })
}

section('D. the live leg — a real vitest elsewhere when MERCURY_PROOF_RUNNER_MODULES names a node_modules that carries it')
{
  const modules = process.env.MERCURY_PROOF_RUNNER_MODULES
  const vitestBin = modules ? path.join(modules, '.bin', 'vitest') : ''
  if (!modules || !existsSync(vitestBin)) {
    console.log(`  [SKIP — LOUD] no vitest on this machine (${modules ? `${vitestBin} absent` : 'MERCURY_PROOF_RUNNER_MODULES unset'}) — the stand-in above is the evidence; point MERCURY_PROOF_RUNNER_MODULES at a node_modules carrying vitest to run this leg`)
  } else {
    const session = path.join(scratch, 'session-d')
    mkdirSync(session)
    const live = path.join(scratch, 'elsewhere-d', 'live-vitest')
    mkdirSync(live, { recursive: true })
    writeFileSync(path.join(live, 'package.json'), JSON.stringify({ name: 'live', private: true, type: 'module', devDependencies: { vitest: '*' } }) + '\n')
    writeFileSync(path.join(live, 'bun.lock'), '{}\n')
    symlinkSync(modules, path.join(live, 'node_modules'))
    mkdirSync(path.join(live, 'src'))
    writeFileSync(path.join(live, 'src', 'calc.test.mjs'), ["import { it, expect } from 'vitest'", "it('adds', () => { expect(1 + 1).toBe(2) })", "it('wrong on purpose', () => { expect(2 + 2).toBe(5) })", ''].join('\n'))
    const run = await call(session, { op: 'run', path: live })
    check('D1 a real vitest run from a session folder elsewhere: 1 passed · 1 failed, in the project', run.data.record?.framework === 'vitest' && run.data.record?.cwd === live && run.data.record?.counts.passed === 1 && run.data.record?.counts.failed === 1 && firstLine(run).endsWith(` (in ${live})`), run.data.result)
    rmSync(path.join(scratch, 'elsewhere-d'), { recursive: true, force: true })
    rmSync(session, { recursive: true, force: true })
  }
}

rmSync(scratch, { recursive: true, force: true })
clearTimeout(guard)
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'test-path-project: ALL LAWS HOLD' : `test-path-project: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
