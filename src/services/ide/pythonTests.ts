import { projectHomeStore } from '../../utils/projectHomeStores.js'
import { spawn, spawnSync } from 'node:child_process'
import { settleChildRun } from '../../utils/childSettle.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { storeArtifact } from '../../utils/artifacts/store.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  findPythonProjectRoot,
  buildPythonProjectProfile,
  selectPythonInterpreter,
} from './pythonProject.js'

export function pythonTestsEnabled(): boolean {
  return flagEnabled('MERCURY_TESTS')
}

export type TestFramework = 'pytest' | 'unittest'

export type RunnerFramework = 'node-test' | 'vitest' | 'jest' | 'cargo' | 'go'

export type EngineFramework = 'unity'

export interface TestCaseResult {
  id: string
  nameParts?: string[]
  outcome: 'passed' | 'failed' | 'skipped' | 'errored'
  message?: string
  file?: string
  line?: number
  durationMs?: number
}

export interface TestRunRecord {
  schema: 1
  id: string
  framework: TestFramework | RunnerFramework | EngineFramework

  selection: string
  command: string[]
  cwd: string
  interpreter: string
  startedAt: number
  durationMs: number
  counts: { passed: number; failed: number; skipped: number; errored: number }

  cases: TestCaseResult[]
  casesTruncated?: number

  failures: string[]

  outputArtifactRef?: string
  outputTail: string[]
  exitCode: number | null

  verdict?: 'no-match' | 'zero-run' | 'uncollected'
  verdictNote?: string

  diagnosticsNote?: string
}

type TestRunOutcome =
  | { state: 'ok'; record: TestRunRecord }
  | { state: 'unavailable'; reason: string; remedy: string }

const CASE_CAP = 200
const OUTPUT_TAIL_LINES = 40
const RUN_TIMEOUT_MS = 300_000

let pytestProbeCache: { at: number; key: string; result: { available: boolean; version?: string; detail: string } } | null = null

export function probePytest(from: string = getCwd()): { available: boolean; version?: string; detail: string } {
  const selection = selectPythonInterpreter(from)
  if (selection.state !== 'ok') {
    return { available: false, detail: selection.detail }
  }
  const key = selection.command
  if (pytestProbeCache && pytestProbeCache.key === key && Date.now() - pytestProbeCache.at < 30_000) {
    return pytestProbeCache.result
  }
  let result: { available: boolean; version?: string; detail: string }
  try {

    const r = spawnSync(selection.command, ['-c', 'import pytest; print(pytest.__version__)'], {
      windowsHide: true,
      timeout: 10_000,
      encoding: 'utf8',
      env: { ...subprocessEnv() },
    })
    result =
      r.status === 0
        ? { available: true, version: (r.stdout ?? '').trim(), detail: `pytest ${(r.stdout ?? '').trim()} on ${selection.command}` }
        : { available: false, detail: `pytest not importable on ${selection.command} (pip install pytest)` }
  } catch (e) {
    result = { available: false, detail: `pytest probe failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  pytestProbeCache = { at: Date.now(), key, result }
  return result
}

export function _resetPytestProbeForTesting(): void {
  pytestProbeCache = null
}

function resolveFramework(from: string = getCwd(), explicit?: TestFramework): TestFramework {
  if (explicit) return explicit
  const profile = buildPythonProjectProfile(from)
  if (profile.testFrameworks.pytest.detected && probePytest(from).available) return 'pytest'
  return 'unittest'
}

function namedFiles(files: readonly string[]): string {
  return `${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}`
}

function namedTestFiles(files: readonly string[]): string {
  return `${files.length} test file(s) found (${namedFiles(files)})`
}

export function pytestFallbackNote(from: string = getCwd(), uncollected?: readonly string[]): string | null {
  const profile = buildPythonProjectProfile(from)
  const { pytest } = profile.testFrameworks
  if (!pytest.detected) return null
  const probe = probePytest(from)
  if (pytest.configured) {
    if (probe.available) return null
    return (
      `NOTE: pytest is configured (${pytest.evidence ?? 'project markers'}) but ${probe.detail} — ` +
      `fell back to unittest. pip install pytest (into the selected interpreter) restores the pytest lane.`
    )
  }
  const skipped = uncollected ?? profile.testFrameworks.bareFiles
  if (skipped.length === 0) return null
  return `NOTE: ${uncollectedNote(from, skipped)}`
}

function pytestMissingWhy(interpreter: string): string {
  return `pytest is not importable for ${interpreter}; install it (pip install pytest) or name the framework`
}

const UNITTEST_COLLECTS = 'the unittest lane collects unittest.TestCase classes from test*.py files only'

function uncollectedWhy(from: string): string {
  const profile = buildPythonProjectProfile(from)
  const interpreter = profile.interpreter.state === 'ok' ? profile.interpreter.command : 'the selected interpreter'
  return probePytest(from).available ? 'pass framework: "pytest" to run them under pytest' : pytestMissingWhy(interpreter)
}

function uncollectedNote(from: string, skipped: readonly string[]): string {
  return `${skipped.length} test file(s) not collected (${namedFiles(skipped)}) — ${UNITTEST_COLLECTS}; ${uncollectedWhy(from)}`
}

function zeroRunNote(from: string, framework: TestFramework, interpreter: string, testFiles: readonly string[], runnerWords: string): string {
  const why =
    framework === 'unittest' && !probePytest(from).available
      ? pytestMissingWhy(interpreter)
      : framework === 'unittest'
        ? `${UNITTEST_COLLECTS} — ${runnerWords}; pass framework: "pytest" to run them under pytest`
        : runnerWords
  return `${namedTestFiles(testFiles)}, the ${framework} lane ran 0 — ${why}`
}

function uncollectedUnittestFiles(root: string, testFiles: readonly string[], collected: { ids?: readonly string[]; files?: readonly string[] }): string[] {
  const seen = new Set<string>()
  const relOf = (abs: string): string | null => {
    for (const base of [root, realpathOrSelf(root)]) {
      const rel = path.relative(base, realpathOrSelf(abs)).split(path.sep).join('/')
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel
    }
    return null
  }
  for (const file of collected.files ?? []) {
    const rel = relOf(file)
    if (rel !== null) seen.add(rel)
  }
  for (const id of collected.ids ?? []) {
    const parts = id.split('.')
    for (let i = parts.length - 1; i >= 1; i--) {
      const candidate = `${parts.slice(0, i).join('/')}.py`
      if (testFiles.includes(candidate)) {
        seen.add(candidate)
        break
      }
    }
  }
  return testFiles.filter(f => !seen.has(f))
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const PYTEST_PLUGIN_SOURCE = `
import json, os, time

class MercuryReport:
    def __init__(self, out, root):
        self.out = out
        self.root = os.path.realpath(root)
    def _emit(self, obj):
        self.out.write(json.dumps(obj) + "\\n")
        self.out.flush()
    def _stop(self, entry, longrepr):
        crash = getattr(longrepr, "reprcrash", None)
        path = getattr(crash, "path", None)
        if not path:
            return
        try:
            rel = os.path.relpath(os.path.realpath(path), self.root)
            entry["file"] = path if rel.startswith(os.pardir) else rel
        except ValueError:
            entry["file"] = path
        if getattr(crash, "lineno", None) is not None:
            entry["line"] = int(crash.lineno)
    def pytest_collectreport(self, report):
        if report.failed:
            entry = {"t": "collect-error", "id": str(report.nodeid), "message": str(report.longrepr)[-800:]}
            self._stop(entry, report.longrepr)
            self._emit(entry)
    def pytest_itemcollected(self, item):
        self._emit({"t": "collect", "id": item.nodeid})
    def pytest_runtest_logreport(self, report):
        if report.when == "call" or report.outcome != "passed":
            outcome = report.outcome  # passed | failed | skipped
            if report.when != "call" and report.outcome == "failed":
                outcome = "errored"
            entry = {
                "t": "case",
                "id": report.nodeid,
                "outcome": outcome,
                "durationMs": int(report.duration * 1000),
            }
            if report.longrepr is not None:
                entry["message"] = str(report.longrepr)[-800:]
            try:
                path, line, _ = report.location
                entry["file"] = path
                if line is not None:
                    entry["line"] = int(line) + 1
            except Exception:
                pass
            if outcome != "passed":
                self._stop(entry, report.longrepr)
            self._emit(entry)

def pytest_configure(config):
    out = open(config.getoption("--mercury-report"), "a")
    config.pluginmanager.register(MercuryReport(out, str(getattr(config, "rootpath", None) or config.rootdir)), "mercury-report")

def pytest_addoption(parser):
    parser.addoption("--mercury-report", action="store", default="mercury-report.ndjson")
`

export const UNITTEST_RUNNER_SOURCE = `
import importlib, json, os, sys, time, unittest

def selection_plan(start_dir, items, osp=os.path, isfile=None, isdir=None):
    isfile = osp.isfile if isfile is None else isfile
    isdir = osp.isdir if isdir is None else isdir
    root = osp.abspath(start_dir)
    def inside(target):
        try:
            rel = osp.relpath(target, root)
        except ValueError:
            return None
        if rel == osp.curdir:
            return ""
        if rel.startswith(osp.pardir) or osp.isabs(rel):
            return None
        return osp.normpath(rel)
    plan = []
    for item in items:
        if isdir(item):
            folder = osp.abspath(item)
            rel = inside(folder)
            packaged = rel == "" or (rel is not None and isfile(osp.join(folder, "__init__.py")))
            plan.append({"kind": "folder", "start": folder, "top": root if packaged else folder})
        elif isfile(item) and item.lower().endswith(".py"):
            path = osp.abspath(item)
            rel = inside(path)
            if rel is None:
                plan.append({"kind": "file", "start": osp.dirname(path), "top": osp.dirname(path), "pattern": osp.basename(path)})
            else:
                plan.append({"kind": "name", "name": rel[:-3].replace("\\\\", ".").replace("/", ".")})
        elif item.lower().endswith(".py") or osp.sep in item or "/" in item:
            plan.append({"kind": "missing", "name": item})
        else:
            plan.append({"kind": "name", "name": item})
    return plan

def missing_part(name):
    parts = name.split(".")
    module = None
    k = len(parts)
    while k > 0:
        prefix = ".".join(parts[:k])
        try:
            module = importlib.import_module(prefix)
            break
        except ModuleNotFoundError as error:
            absent = getattr(error, "name", None)
            if absent is None or not (prefix == absent or prefix.startswith(absent + ".") or absent.startswith(prefix + ".")):
                return None
        except Exception:
            return None
        k -= 1
    if module is None:
        return parts[0]
    obj = module
    for part in parts[k:]:
        if not hasattr(obj, part):
            return part
        obj = getattr(obj, part)
    return None

if __name__ == "__main__":
    report_path = sys.argv[1]
    mode = sys.argv[2]
    start_dir = sys.argv[3]
    selection = sys.argv[4:]
    if start_dir not in sys.path:
        sys.path.insert(0, start_dir)

    out = open(report_path, "a")
    def emit(obj):
        out.write(json.dumps(obj) + "\\n")
        out.flush()

    def iter_tests(suite):
        for item in suite:
            if isinstance(item, unittest.TestSuite):
                yield from iter_tests(item)
            else:
                yield item

    loader = unittest.TestLoader()
    unloadable = []
    missing = []
    if selection:
        suite = unittest.TestSuite()
        for target in selection_plan(start_dir, selection):
            try:
                if target["kind"] == "missing":
                    missing.append((target["name"], "no such file or directory: %s" % target["name"]))
                elif target["kind"] == "name":
                    for test in iter_tests(loader.loadTestsFromName(target["name"])):
                        unloaded = type(test).__name__ == "_FailedTest" and type(test).__module__ == "unittest.loader"
                        if unloaded and missing_part(target["name"]) is not None:
                            exc = getattr(test, "_exception", None)
                            lines = str(exc).strip().splitlines() if exc is not None else []
                            missing.append((target["name"], lines[-1] if len(lines) > 1 else "%s: %s" % (type(exc).__name__, exc) if exc is not None else "not found"))
                        else:
                            suite.addTest(test)
                elif target["kind"] == "folder":
                    suite.addTests(loader.discover(target["start"], top_level_dir=target["top"]))
                else:
                    suite.addTests(loader.discover(target["start"], pattern=target["pattern"], top_level_dir=target["top"]))
            except Exception as error:
                words = "%s: %s" % (type(error).__name__, error)
                if target["kind"] == "name" and missing_part(target["name"]) is not None:
                    missing.append((target["name"], words))
                else:
                    unloadable.append((target.get("name") or target["start"], words))
    else:
        suite = loader.discover(start_dir)

    if mode == "discover":
        for err in loader.errors:
            emit({"t": "collect-error", "id": "loader", "message": str(err)[:800]})
        for name, message in unloadable + missing:
            emit({"t": "collect-error", "id": name, "message": message[:800]})
        for test in iter_tests(suite):
            emit({"t": "collect", "id": test.id()})
        sys.exit(0)

    class MercuryResult(unittest.TextTestResult):
        def _entry(self, test, outcome, err=None):
            entry = {"t": "case", "id": test.id(), "outcome": outcome,
                     "durationMs": int((time.time() - getattr(test, "_mercury_t0", time.time())) * 1000)}
            if err is not None:
                entry["message"] = self._exc_info_to_string(err, test)[-800:]
            fn = getattr(sys.modules.get(type(test).__module__), "__file__", None)
            if fn:
                entry["file"] = fn
            emit(entry)
        def startTest(self, test):
            test._mercury_t0 = time.time()
            super().startTest(test)
        def addSuccess(self, test):
            super().addSuccess(test)
            self._entry(test, "passed")
        def addFailure(self, test, err):
            super().addFailure(test, err)
            self._entry(test, "failed", err)
        def addError(self, test, err):
            super().addError(test, err)
            self._entry(test, "errored", err)
        def addSkip(self, test, reason):
            super().addSkip(test, reason)
            emit({"t": "case", "id": test.id(), "outcome": "skipped", "message": str(reason)[:200]})

    for name, message in unloadable:
        emit({"t": "case", "id": "unittest.loader._FailedTest." + name, "outcome": "errored", "message": message[:800]})
    for name, message in missing:
        emit({"t": "no-match", "id": name, "message": message[:800]})
    runner = unittest.TextTestRunner(resultclass=MercuryResult, verbosity=1)
    result = runner.run(suite)
    if unloadable or not result.wasSuccessful() or (missing and result.testsRun > 0):
        sys.exit(1)
    sys.exit(5 if missing else 0)
`

export function testRunsDir(root: string): string {

  return projectHomeStore(root, 'test-runs')
}

function runsDir(root: string): string {
  return testRunsDir(root)
}

export async function persistTestRun(root: string, record: TestRunRecord): Promise<void> {
  const dir = runsDir(root)
  await durableAtomicPublish(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n')
  await durableAtomicPublish(path.join(dir, 'latest.json'), JSON.stringify(record, null, 2) + '\n')
}

async function persistRun(root: string, record: TestRunRecord): Promise<void> {
  await persistTestRun(root, record)
}

export function latestRun(from: string = getCwd()): TestRunRecord | null {
  return latestRunAtRoot(findPythonProjectRoot(from).root)
}

export function latestRunAtRoot(root: string): TestRunRecord | null {
  try {
    return JSON.parse(readFileSync(path.join(runsDir(root), 'latest.json'), 'utf8')) as TestRunRecord
  } catch {
    return null
  }
}

export function getRun(id: string, from: string = getCwd()): TestRunRecord | null {
  const { root } = findPythonProjectRoot(from)
  if (!/^[a-z0-9-]+$/.test(id)) return null
  try {
    return JSON.parse(readFileSync(path.join(runsDir(root), `${id}.json`), 'utf8')) as TestRunRecord
  } catch {
    return null
  }
}

export function listRuns(from: string = getCwd()): Array<{ id: string; startedAt: number; counts: TestRunRecord['counts'] }> {
  const { root } = findPythonProjectRoot(from)
  try {
    return readdirSync(runsDir(root))
      .filter(f => f.startsWith('run-') && f.endsWith('.json'))
      .map(f => {
        try {
          const r = JSON.parse(readFileSync(path.join(runsDir(root), f), 'utf8')) as TestRunRecord
          return { id: r.id, startedAt: r.startedAt, counts: r.counts }
        } catch {
          return null
        }
      })
      .filter((r): r is { id: string; startedAt: number; counts: TestRunRecord['counts'] } => r !== null)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 50)
  } catch {
    return []
  }
}

interface NdjsonEvent {
  t: string
  id?: string
  outcome?: string
  message?: string
  file?: string
  line?: number
  durationMs?: number
}

function readNdjson(reportPath: string): NdjsonEvent[] {
  try {
    return readFileSync(reportPath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => {
        try {
          return JSON.parse(l) as NdjsonEvent
        } catch {
          return null
        }
      })
      .filter((e): e is NdjsonEvent => e !== null)
  } catch {
    return []
  }
}

async function spawnCollecting(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; output: string[] }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'], env: env ?? { ...subprocessEnv() } })
    const output: string[] = []
    const push = (chunk: Buffer): void => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) output.push(line)
      }
      if (output.length > 5_000) output.splice(0, output.length - 5_000)
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)

    void settleChildRun(child, { timeoutMs: RUN_TIMEOUT_MS, ...(signal ? { signal } : {}) }).then(settlement => {
      if (settlement.spawnError !== undefined) output.push(`spawn failed: ${settlement.spawnError}`)
      if (settlement.timedOut) output.push(`the run timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s — its process tree was ended`)
      if (settlement.aborted) output.push('the run was interrupted — its process tree was ended')
      resolve({
        exitCode: settlement.timedOut || settlement.aborted ? null : settlement.code,
        output,
      })
    })
  })
}

interface DiscoverOutcome {
  framework: TestFramework
  tests: string[]
  collectErrors: string[]
  truncated?: number
  uncollected?: string[]
}

export async function discoverPythonTests(opts?: {
  from?: string
  framework?: TestFramework
  signal?: AbortSignal
}): Promise<DiscoverOutcome | { state: 'unavailable'; reason: string; remedy: string }> {
  const from = opts?.from ?? getCwd()
  const { root } = findPythonProjectRoot(from)
  const selection = selectPythonInterpreter(from)
  if (selection.state !== 'ok') {
    return { state: 'unavailable', reason: selection.detail, remedy: selection.remedy }
  }
  const framework = resolveFramework(from, opts?.framework)
  if (framework === 'pytest' && !probePytest(from).available) {
    return { state: 'unavailable', reason: probePytest(from).detail, remedy: 'pip install pytest (into the selected interpreter), or pass framework: "unittest"' }
  }
  const scratch = mkdtempSync(path.join(tmpdir(), 'mercury-test-'))
  const report = path.join(scratch, 'report.ndjson')
  let exitCode: number | null
  let output: string[]
  if (framework === 'pytest') {
    writeFileSync(path.join(scratch, 'mercury_report_plugin.py'), PYTEST_PLUGIN_SOURCE)

    const pluginEnv: NodeJS.ProcessEnv = {
      ...subprocessEnv(),
      PYTHONPATH: `${scratch}${path.delimiter}${process.env.PYTHONPATH ?? ''}`,
    }
    const r = await spawnCollecting(
      selection.command,
      ['-m', 'pytest', '--collect-only', '-q', '-p', 'mercury_report_plugin', '--mercury-report', report, '-p', 'no:cacheprovider', '--rootdir', root],
      root,
      opts?.signal,
      pluginEnv,
    )
    exitCode = r.exitCode
    output = r.output

    if (readNdjson(report).length === 0 && r.output.some(l => l.includes('mercury_report_plugin'))) {
      const retry = await spawnCollecting(
        selection.command,
        ['-m', 'pytest', '--collect-only', '-q', '-p', 'mercury_report_plugin', '--mercury-report', report, '-p', 'no:cacheprovider'],
        root,
        opts?.signal,
        pluginEnv,
      )
      exitCode = retry.exitCode
      output = retry.output
    }
  } else {
    writeFileSync(path.join(scratch, 'mercury_unittest_runner.py'), UNITTEST_RUNNER_SOURCE)
    const r = await spawnCollecting(
      selection.command,
      [path.join(scratch, 'mercury_unittest_runner.py'), report, 'discover', root],
      root,
      opts?.signal,
    )
    exitCode = r.exitCode
    output = r.output
  }
  const events = readNdjson(report)
  const tests = events.filter(e => e.t === 'collect' && e.id).map(e => e.id!)
  const collectErrors = events.filter(e => e.t === 'collect-error').map(e => `${e.id}: ${e.message ?? ''}`.slice(0, 200))
  if (tests.length === 0 && collectErrors.length === 0 && exitCode !== 0) {
    return {
      state: 'unavailable',
      reason: `discovery produced no structured records (exit ${exitCode ?? 'null'}): ${output.slice(-3).join(' · ').slice(0, 240)}`,
      remedy: framework === 'pytest' ? 'check pytest can import your tests (run pytest --collect-only manually)' : 'check unittest discovery (python -m unittest discover)',
    }
  }
  const cap = 500
  const uncollected = framework === 'unittest' ? uncollectedUnittestFiles(root, buildPythonProjectProfile(from).testFrameworks.testFiles, { ids: tests }) : []
  return {
    framework,
    tests: tests.slice(0, cap),
    collectErrors,
    ...(tests.length > cap ? { truncated: tests.length - cap } : {}),
    ...(uncollected.length > 0 ? { uncollected } : {}),
  }
}

interface RunOptions {
  from?: string
  framework?: TestFramework

  selection?: string[]
  selectionLabel?: string
  signal?: AbortSignal
}

let runSeq = 0

const PYTEST_NO_MATCH_WORDS = [/^\(no match in any of .*\)$/, /^ERROR: (?:not found|file or directory not found): .*$/, /^\d+ deselected in .*$/, /^no tests ran in .*$/]
const UNITTEST_NO_MATCH_WORDS = [/^Ran 0 tests in .*$/, /^NO TESTS RAN$/]

function pythonNoMatchWords(framework: TestFramework, exitCode: number | null, output: string[]): string | undefined {
  const words: string[] = []
  for (const re of framework === 'pytest' ? PYTEST_NO_MATCH_WORDS : UNITTEST_NO_MATCH_WORDS) {
    const line = output.find(l => re.test(l.trim()))
    if (line !== undefined && !words.includes(line.trim())) words.push(line.trim())
  }
  if (words.length === 0 && exitCode === 5) words.push(`exit 5 (${framework === 'pytest' ? 'no tests collected' : 'no tests ran'})`)
  return words.length === 0 ? undefined : words.slice(0, 2).join(' · ')
}

export async function runPythonTests(opts?: RunOptions): Promise<TestRunOutcome> {
  const from = opts?.from ?? getCwd()
  const { root } = findPythonProjectRoot(from)
  const selection = selectPythonInterpreter(from)
  if (selection.state !== 'ok') {
    return { state: 'unavailable', reason: selection.detail, remedy: selection.remedy }
  }
  const framework = resolveFramework(from, opts?.framework)
  if (framework === 'pytest' && !probePytest(from).available) {
    return {
      state: 'unavailable',
      reason: probePytest(from).detail,
      remedy: 'pip install pytest (into the selected interpreter), or pass framework: "unittest"',
    }
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'mercury-test-'))
  const report = path.join(scratch, 'report.ndjson')
  const startedAt = Date.now()
  const id = `run-${startedAt}-${++runSeq}`
  const sel = opts?.selection ?? []

  let command: string[]
  if (framework === 'pytest') {
    writeFileSync(path.join(scratch, 'mercury_report_plugin.py'), PYTEST_PLUGIN_SOURCE)
    command = [
      selection.command,
      '-m',
      'pytest',
      ...sel,
      '-q',
      '-p',
      'mercury_report_plugin',
      '--mercury-report',
      report,
      '-p',
      'no:cacheprovider',
    ]
  } else {
    writeFileSync(path.join(scratch, 'mercury_unittest_runner.py'), UNITTEST_RUNNER_SOURCE)
    command = [selection.command, path.join(scratch, 'mercury_unittest_runner.py'), report, 'run', root, ...sel]
  }

  const child = spawn(command[0]!, command.slice(1), {
    windowsHide: true,
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...subprocessEnv(), PYTHONPATH: `${scratch}${path.delimiter}${process.env.PYTHONPATH ?? ''}` },
  })
  const output: string[] = []
  const push = (chunk: Buffer): void => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) output.push(line)
    }
    if (output.length > 5_000) output.splice(0, output.length - 5_000)
  }
  child.stdout.on('data', push)
  child.stderr.on('data', push)
  const settlement = await settleChildRun(child, {
    timeoutMs: RUN_TIMEOUT_MS,
    ...(opts?.signal ? { signal: opts.signal } : {}),
  })
  if (settlement.spawnError !== undefined) output.push(`spawn failed: ${settlement.spawnError}`)
  if (settlement.timedOut) output.push(`the run timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s — its process tree was ended`)
  if (settlement.aborted) output.push('the run was interrupted — its process tree was ended')
  const exitCode = settlement.timedOut || settlement.aborted ? null : settlement.code

  const events = readNdjson(report)
  const cases: TestCaseResult[] = events
    .filter(e => e.id && (e.t === 'collect-error' || (e.t === 'case' && e.outcome)))
    .map(e => ({
      id: e.id!,
      outcome: (e.t === 'case' && ['passed', 'failed', 'skipped', 'errored'].includes(e.outcome!) ? e.outcome : 'errored') as TestCaseResult['outcome'],
      ...(e.message ? { message: e.message } : {}),
      ...(e.file ? { file: e.file } : {}),
      ...(typeof e.line === 'number' ? { line: e.line } : {}),
      ...(typeof e.durationMs === 'number' ? { durationMs: e.durationMs } : {}),
    }))
  const misses = events.filter(e => e.t === 'no-match' && e.id)
  const counts = {
    passed: cases.filter(c => c.outcome === 'passed').length,
    failed: cases.filter(c => c.outcome === 'failed').length,
    skipped: cases.filter(c => c.outcome === 'skipped').length,
    errored: cases.filter(c => c.outcome === 'errored').length,
  }
  const failures = cases.filter(c => c.outcome === 'failed' || c.outcome === 'errored').map(c => c.id)

  const selectionLabel = opts?.selectionLabel ?? (sel.length ? `nodes:${sel.join(',')}`.slice(0, 200) : 'all')
  const missWords = misses.slice(0, 2).map(m => m.message ?? `${m.id} not found`).join(' · ')
  const noMatchWords = cases.length === 0 ? (misses.length > 0 ? missWords : pythonNoMatchWords(framework, exitCode, output)) : undefined
  const testFiles = selectionLabel === 'all' && (noMatchWords !== undefined || framework === 'unittest') ? buildPythonProjectProfile(from).testFrameworks.testFiles : []
  const uncollected =
    framework === 'unittest' && noMatchWords === undefined && cases.length > 0 && selectionLabel === 'all'
      ? uncollectedUnittestFiles(root, testFiles, { files: cases.map(c => c.file ?? '').filter(Boolean) })
      : []
  const verdict: TestRunRecord['verdict'] =
    noMatchWords !== undefined ? (testFiles.length > 0 ? 'zero-run' : 'no-match') : uncollected.length > 0 ? 'uncollected' : undefined
  let verdictNote: string | undefined
  if (verdict === 'zero-run') {
    verdictNote = zeroRunNote(from, framework, selection.command, testFiles, noMatchWords!)
  } else if (verdict === 'uncollected') {
    verdictNote = uncollectedNote(from, uncollected)
  } else if (noMatchWords !== undefined) {
    verdictNote = `${selectionLabel === 'all' ? 'no test ran' : `no test matched ${selectionLabel}`} — ${noMatchWords}`
  } else if (misses.length > 0) {
    verdictNote = `${misses.length} of the selection matched no test — ${misses.slice(0, 3).map(m => `${m.id}: ${m.message ?? 'not found'}`).join(' · ')}`
  } else if (cases.length === 0) {
    verdictNote = `no structured case records arrived (exit ${exitCode ?? 'null'}) — the run is EVIDENCE-FREE, treat as errored`
  } else if (exitCode === 0 && failures.length > 0) {
    verdictNote = 'exit code 0 disagreed with recorded failures — structured records win'
  } else if (exitCode !== 0 && exitCode !== null && failures.length === 0 && counts.passed > 0) {
    verdictNote = `exit ${exitCode} with no recorded failure — inspect the output artifact`
  }

  let outputArtifactRef: string | undefined
  if (output.length > OUTPUT_TAIL_LINES) {
    const { id: artifactId } = await storeArtifact({
      scope: 'test',
      name: id,
      content: output.join('\n'),
      kind: 'test-output',
    })
    if (artifactId) outputArtifactRef = `mercury://artifact/test/${artifactId}`
  }

  const record: TestRunRecord = {
    schema: 1,
    id,
    framework,
    selection: selectionLabel,
    command,
    cwd: root,
    interpreter: selection.command,
    startedAt,
    durationMs: Date.now() - startedAt,
    counts,
    cases: cases.slice(0, CASE_CAP),
    ...(cases.length > CASE_CAP ? { casesTruncated: cases.length - CASE_CAP } : {}),
    failures,
    ...(outputArtifactRef ? { outputArtifactRef } : {}),
    outputTail: output.slice(-OUTPUT_TAIL_LINES),
    exitCode,
    ...(verdict !== undefined ? { verdict } : {}),
    ...(verdictNote ? { verdictNote } : {}),
  }
  try {
    await persistRun(root, record)
  } catch (e) {
    logForDebugging(`pythonTests: run record persistence failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { state: 'ok', record }
}

export function noMatchRerunNote(latest: Pick<TestRunRecord, 'id' | 'selection' | 'verdictNote'>): string {
  return `latest run ${latest.id} matched no test — nothing to rerun; ${latest.verdictNote ?? `no test matched ${latest.selection}`}`
}

export async function rerunFailedTests(opts?: { from?: string; signal?: AbortSignal }): Promise<
  TestRunOutcome | { state: 'nothing-to-rerun'; note: string }
> {
  const from = opts?.from ?? getCwd()
  const latest = latestRun(from)
  if (!latest) return { state: 'nothing-to-rerun', note: 'no recorded run yet — run the suite first' }
  if (latest.framework !== 'pytest' && latest.framework !== 'unittest') {

    return {
      state: 'unavailable',
      reason: `latest run ${latest.id} is a ${latest.framework} run, not a python run`,
      remedy: 'rerun through the runner lane (the Test tool routes rerunFailed by record framework)',
    }
  }
  if (latest.verdict === 'zero-run') {
    return { state: 'nothing-to-rerun', note: `latest run ${latest.id} ran 0 tests — nothing to rerun; ${latest.verdictNote ?? 'the whole suite ran nothing'}` }
  }
  if (latest.verdict === 'no-match') {
    return { state: 'nothing-to-rerun', note: noMatchRerunNote(latest) }
  }
  if (latest.failures.length === 0) {
    const skipped = latest.verdict === 'uncollected' ? ` among the tests it ran; ${latest.verdictNote ?? 'test files were not collected'}` : ''
    return { state: 'nothing-to-rerun', note: `latest run ${latest.id} had no failures${skipped} — nothing to rerun` }
  }
  return runPythonTests({
    from,
    framework: latest.framework,
    selection: latest.failures,
    selectionLabel: 'rerun-failed',
    ...(opts?.signal ? { signal: opts.signal } : {}),
  })
}

interface DebugShim {
  framework: TestFramework
  program: string
  cwd: string
  note: string
}

export function buildDebugTestShim(nodeId: string, opts?: { from?: string; framework?: TestFramework }): DebugShim | { state: 'unavailable'; reason: string; remedy: string } {
  const from = opts?.from ?? getCwd()
  const { root } = findPythonProjectRoot(from)
  const framework = resolveFramework(from, opts?.framework)
  if (framework === 'pytest' && !probePytest(from).available) {
    return { state: 'unavailable', reason: probePytest(from).detail, remedy: 'pip install pytest, or pass framework: "unittest"' }
  }
  const scratch = mkdtempSync(path.join(tmpdir(), 'mercury-test-debug-'))
  const program = path.join(scratch, 'mercury_debug_test.py')
  if (framework === 'pytest') {
    writeFileSync(
      program,
      `import sys\nimport pytest\nraise SystemExit(pytest.main([${JSON.stringify(nodeId)}, "-x", "-q", "-p", "no:cacheprovider"]))\n`,
    )
  } else {
    writeFileSync(
      program,
      `import sys\nsys.path.insert(0, ${JSON.stringify(root)})\nimport unittest\nunittest.main(module=None, argv=["mercury-debug-test", ${JSON.stringify(nodeId)}])\n`,
    )
  }
  return {
    framework,
    program,
    cwd: root,
    note: `debug shim for ${nodeId} (${framework}) — launch via the python adapter; breakpoints bind in the real test files`,
  }
}
