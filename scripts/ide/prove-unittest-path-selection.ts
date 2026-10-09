#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const SYS_PY = '/usr/bin/python3'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

if (!existsSync(SYS_PY)) {
  console.log(`\n  [SKIP — LOUD] ${SYS_PY} absent — the journey needs one known-good interpreter.`)
  process.exit(0)
}
process.env.MERCURY_PYTHON = SYS_PY
delete process.env.MERCURY_TESTS

const scratch = mkdtempSync(path.join(tmpdir(), 'mercury-unittest-path-'))
const repo = path.join(scratch, 'repo')
const elsewhere = path.join(scratch, 'elsewhere')
mkdirSync(path.join(repo, 'tests'), { recursive: true })
mkdirSync(path.join(repo, 'plain'), { recursive: true })
mkdirSync(elsewhere, { recursive: true })
writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\nname = "wordcount"\nversion = "0.0.1"\n')
writeFileSync(path.join(repo, 'wordcount.py'), 'def count(text):\n    return len(text.split())\n')
writeFileSync(path.join(repo, 'test_wordcount.py'), 'import unittest\nfrom wordcount import count\n\nclass TestWordcount(unittest.TestCase):\n    def test_count(self):\n        self.assertEqual(count("a b c"), 3)\n')
writeFileSync(path.join(repo, 'tests', '__init__.py'), '')
writeFileSync(path.join(repo, 'tests', 'test_more.py'), 'import unittest\n\nclass TestMore(unittest.TestCase):\n    def test_more(self):\n        self.assertTrue(True)\n')
writeFileSync(path.join(repo, 'plain', 'test_plain.py'), 'import unittest\n\nclass TestPlain(unittest.TestCase):\n    def test_plain(self):\n        self.assertTrue(True)\n')
writeFileSync(path.join(elsewhere, 'test_else.py'), 'import unittest\n\nclass TestElse(unittest.TestCase):\n    def test_else(self):\n        self.assertEqual(1, 2)\n')

process.chdir(repo)
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const tests = await import('../../src/services/ide/pythonTests.js')
const { _resetPythonProjectForTesting } = await import('../../src/services/ide/pythonProject.js')
_resetPythonProjectForTesting()

type Record = Extract<Awaited<ReturnType<typeof tests.runPythonTests>>, { state: 'ok' }>['record']

async function run(selection: string[]): Promise<Record | null> {
  const out = await tests.runPythonTests({ from: repo, framework: 'unittest', selection, selectionLabel: `file:${selection.join(',')}` })
  if (out.state !== 'ok') {
    console.log(`  [dbg] run unavailable: ${j(out)}`)
    return null
  }
  return out.record
}

const ranLine = (record: Record): string => record.outputTail.find(line => /^Ran \d+ tests? in/.test(line)) ?? ''
const ranCount = (record: Record): number => Number(/^Ran (\d+) test/.exec(ranLine(record))?.[1] ?? -1)
const verdictLine = (record: Record): string => record.outputTail.find(line => /^(OK|FAILED)/.test(line)) ?? ''
const ids = (record: Record): string[] => record.cases.map(c => `${c.id}:${c.outcome}`)
const total = (record: Record): number => record.counts.passed + record.counts.failed + record.counts.skipped + record.counts.errored

try {
  section('§1 path = the test file at the root (the box\'s shape): the module is loaded by its name relative to the root')
  {
    const record = await run([path.join(repo, 'test_wordcount.py')])
    check('the run lands', record !== null)
    if (record) {
      check('one case, passed, named by its module — not a _FailedTest for a path spelled as a module', ids(record).join() === 'test_wordcount.TestWordcount.test_count:passed', j(ids(record)))
      check('the counts agree with unittest\'s own line', total(record) === ranCount(record) && record.counts.errored === 0 && verdictLine(record) === 'OK', `${j(record.counts)} vs ${ranLine(record)} ${verdictLine(record)}`)
      check('no ModuleNotFoundError names the path', !j(record.cases).includes('No module named'), j(record.cases).slice(0, 300))
    }
  }

  section('§2 path = the repo folder: unittest\'s own discovery from the root')
  {
    const record = await run([repo])
    check('the run lands', record !== null)
    if (record) {
      check('both packaged tests ran and passed', ids(record).sort().join() === 'test_wordcount.TestWordcount.test_count:passed,tests.test_more.TestMore.test_more:passed', j(ids(record)))
      check('the counts agree with unittest\'s own line', total(record) === ranCount(record) && ranCount(record) === 2 && verdictLine(record) === 'OK', `${j(record.counts)} vs ${ranLine(record)}`)
    }
  }

  section('§3 path = a file in a package under the root, and the package folder itself')
  {
    const file = await run([path.join(repo, 'tests', 'test_more.py')])
    check('the file in the package loads as tests.test_more', file !== null && ids(file).join() === 'tests.test_more.TestMore.test_more:passed', file ? j(ids(file)) : 'no record')
    const folder = await run([path.join(repo, 'tests')])
    check('the package folder discovers the same test under the root', folder !== null && ids(folder).join() === 'tests.test_more.TestMore.test_more:passed' && folder.counts.errored === 0, folder ? j(ids(folder)) : 'no record')
  }

  section('§4 path = a folder that is not a package, and a file in it: discovered from the folder itself')
  {
    const folder = await run([path.join(repo, 'plain')])
    check('the plain folder runs its test', folder !== null && ids(folder).join() === 'test_plain.TestPlain.test_plain:passed', folder ? j(ids(folder)) : 'no record')
    const file = await run([path.join(repo, 'plain', 'test_plain.py')])
    check('the file in the plain folder loads by its name under the root', file !== null && file.counts.passed === 1 && file.counts.errored === 0, file ? j(ids(file)) : 'no record')
  }

  section('§5 path = a test file outside the root: run through unittest\'s own file road from its own folder')
  {
    const record = await run([path.join(elsewhere, 'test_else.py')])
    check('the outside file runs and its real failure is read', record !== null && ids(record).join() === 'test_else.TestElse.test_else:failed', record ? j(ids(record)) : 'no record')
    if (record) check('the counts agree with unittest\'s own line', total(record) === ranCount(record) && record.counts.failed === 1 && record.counts.errored === 0, `${j(record.counts)} vs ${ranLine(record)} ${verdictLine(record)}`)
  }

  section('§6 a name that loads nothing errs ONCE — the count agrees with unittest\'s "errors=1"')
  {
    const record = await run(['nonsense.module'])
    check('the run lands', record !== null)
    if (record) {
      check('one errored case', record.counts.errored === 1 && ids(record).length === 1 && ids(record)[0]!.endsWith(':errored'), j({ counts: record.counts, ids: ids(record) }))
      check('the counts agree with unittest\'s own line', total(record) === ranCount(record) && verdictLine(record) === 'FAILED (errors=1)', `${j(record.counts)} vs ${ranLine(record)} ${verdictLine(record)}`)
      check('the case carries the import error for the model to read', (record.cases[0]?.message ?? '').includes('No module named'), (record.cases[0]?.message ?? '').slice(0, 200))
    }
    const discovered = await tests.discoverPythonTests({ from: repo, framework: 'unittest' })
    check('discovery still answers the structured ids', !('state' in discovered) && discovered.tests.length === 2, j(discovered).slice(0, 200))
  }

  section('§7 the plan with Windows-shaped paths (ntpath): both spellings, a package, a plain folder, an outside file, another drive, a node id')
  {
    const runnerPath = path.join(scratch, 'mercury_unittest_runner.py')
    writeFileSync(runnerPath, tests.UNITTEST_RUNNER_SOURCE)
    const harness = [
      'import json, ntpath, sys',
      'ns = {"__name__": "proof"}',
      'exec(open(sys.argv[1]).read(), ns)',
      'BS = chr(92)',
      'root = "C:" + BS + "Users" + BS + "WHQ" + BS + "AppData" + BS + "Local" + BS + "Temp" + BS + "mercury" + BS + "scratchpad" + BS + "repo"',
      'files = {root + BS + "test_wordcount.py", root + BS + "tests" + BS + "__init__.py", root + BS + "tests" + BS + "test_more.py", "C:" + BS + "Users" + BS + "WHQ" + BS + "Desktop" + BS + "other" + BS + "test_other.py", "D:" + BS + "elsewhere" + BS + "test_d.py"}',
      'dirs = {root, root + BS + "tests", root + BS + "plain"}',
      'norm = lambda p: ntpath.normcase(ntpath.normpath(p))',
      'isfile = lambda p: norm(p) in {norm(f) for f in files}',
      'isdir = lambda p: norm(p) in {norm(d) for d in dirs}',
      'items = [root + BS + "test_wordcount.py", root.replace(BS, "/") + "/test_wordcount.py", root.lower() + BS + "test_wordcount.py", root, root + BS + "tests", root + BS + "plain", root + BS + "tests" + BS + "test_more.py", "C:" + BS + "Users" + BS + "WHQ" + BS + "Desktop" + BS + "other" + BS + "test_other.py", "D:" + BS + "elsewhere" + BS + "test_d.py", "test_wordcount.TestWordcount.test_count"]',
      'print(json.dumps(ns["selection_plan"](root, items, osp=ntpath, isfile=isfile, isdir=isdir)))',
    ].join('\n')
    const r = spawnSync(SYS_PY, ['-c', harness, runnerPath], { encoding: 'utf8' })
    check('the plan harness runs', r.status === 0, r.stderr.slice(0, 300))
    const plan = r.status === 0 ? (JSON.parse(r.stdout) as Array<{ kind: string; name?: string; start?: string; top?: string; pattern?: string }>) : []
    const root = 'C:\\Users\\WHQ\\AppData\\Local\\Temp\\mercury\\scratchpad\\repo'
    check('the backslash spelling of the root-level file is the module test_wordcount', plan[0]?.kind === 'name' && plan[0].name === 'test_wordcount', j(plan[0]))
    check('the slash spelling of the same file is the same module', plan[1]?.kind === 'name' && plan[1].name === 'test_wordcount', j(plan[1]))
    check('the lower-case drive spelling is the same module', plan[2]?.kind === 'name' && plan[2].name === 'test_wordcount', j(plan[2]))
    check('the repo folder discovers from the root', plan[3]?.kind === 'folder' && plan[3].start === root && plan[3].top === root, j(plan[3]))
    check('a package folder under the root discovers with the root as the top', plan[4]?.kind === 'folder' && plan[4].start === `${root}\\tests` && plan[4].top === root, j(plan[4]))
    check('a plain folder under the root discovers from itself', plan[5]?.kind === 'folder' && plan[5].start === `${root}\\plain` && plan[5].top === `${root}\\plain`, j(plan[5]))
    check('a file in a package is the dotted module tests.test_more', plan[6]?.kind === 'name' && plan[6].name === 'tests.test_more', j(plan[6]))
    check('a file outside the root runs through unittest\'s file road from its own folder', plan[7]?.kind === 'file' && plan[7].start === 'C:\\Users\\WHQ\\Desktop\\other' && plan[7].top === plan[7].start && plan[7].pattern === 'test_other.py', j(plan[7]))
    check('a file on another drive takes the same road (no relpath error)', plan[8]?.kind === 'file' && plan[8].start === 'D:\\elsewhere' && plan[8].pattern === 'test_d.py', j(plan[8]))
    check('a node id passes through as a name', plan[9]?.kind === 'name' && plan[9].name === 'test_wordcount.TestWordcount.test_count', j(plan[9]))
  }
} finally {
  process.chdir(tmpdir())
  rmSync(scratch, { recursive: true, force: true })
}

clearTimeout(guard)
console.log(failures ? `\n❌ unittest path selection: ${failures} FAILED` : '\n✅ unittest path selection: ALL PASS')
process.exit(failures ? 1 : 0)
