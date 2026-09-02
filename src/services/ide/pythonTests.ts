// ============================================================================
//  ide/pythonTests — structured Python test transactions.
//
//  Tests are TRANSACTIONS, not prose: discovery and runs emit STRUCTURED
//  events by construction — a generated pytest plugin / an embedded stdlib
//  unittest runner stream NDJSON records — so the verdict never comes from
//  parsing human output or trusting a bare exit code (exit-code/record
//  disagreement is itself recorded). Neither framework is vendored: pytest
//  is probed on the SHARED project interpreter (services/ide/pythonProject —
//  the same selection the Workshop kernel, Debug tool and Pyright use);
//  unittest is stdlib and always rides that interpreter.
//
//  Durable truth: every run lands as a revisioned JSON record under
//  <projectRoot>/.mercury/test-runs/ via durableAtomicPublish (crash-
//  consistent), addressable as mercury://test/run/<id> · /latest ·
//  /failures (resources/adapters/test.ts). Full output spills to the
//  artifact store; the record keeps a bounded tail.
//
//  Debugging one test uses the SAME debugpy machinery as the Debug tool:
//  a generated shim program (`pytest.main([nodeid])` / `unittest.main`)
//  launched through createDapSession — no second debugger path, and
//  breakpoints in the real test file bind normally (path-mapped).
//
//  Proof: scripts/ide/prove-python-tests.ts (the unittest arm is stdlib-only
//  and machine-independent; pytest legs probe and skip loudly).
// ============================================================================

import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'
import { spawn, spawnSync } from 'node:child_process'
import { settleChildRun } from '../../utils/childSettle.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

/** The polyglot runner lane's frameworks (projectRunners.ts).
 *  Declared here because THIS module owns the ONE test-run record store. */
export type RunnerFramework = 'node-test' | 'vitest' | 'jest' | 'cargo' | 'go'

/** The engine-bridge executors' framework (the Unity tool's tests_run →
 *  unityRunToRecord in services/ide/unityTests.ts). Declared here for the
 *  same reason as RunnerFramework: one store, zero second ledgers. The
 *  union widened ADDITIVELY when the UNITY-BRIDGE executor landed
 *  (2026-08-29) — the pytest/unittest arm above is byte-unchanged and its
 *  provers stand untouched. */
export type EngineFramework = 'unity'

export interface TestCaseResult {
  id: string
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
  /** What was requested: 'all' | 'file:<p>' | 'nodes:<n>' | 'rerun-failed'. */
  selection: string
  command: string[]
  cwd: string
  interpreter: string
  startedAt: number
  durationMs: number
  counts: { passed: number; failed: number; skipped: number; errored: number }
  /** Bounded case list (cap 200; truncation recorded, never silent). */
  cases: TestCaseResult[]
  casesTruncated?: number
  /** Failing/erroring node ids — the rerun-failed selection. */
  failures: string[]
  /** Full combined output when it exceeded the bounded tail. */
  outputArtifactRef?: string
  outputTail: string[]
  exitCode: number | null
  /** Exit code disagreed with the structured records (recorded, never hidden). */
  verdictNote?: string
  /** Available LSP diagnostics at run end (composed, never a
   *  prerequisite; absent when no live provider). */
  diagnosticsNote?: string
}

export type TestRunOutcome =
  | { state: 'ok'; record: TestRunRecord }
  | { state: 'unavailable'; reason: string; remedy: string }

const CASE_CAP = 200
const OUTPUT_TAIL_LINES = 40
const RUN_TIMEOUT_MS = 300_000

// ── framework probing (on the SHARED interpreter) ───────────────────────────

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
    // env spread is load-bearing (Bun spawnSync drops live env mutations).
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

/** TEST-ONLY: drop the pytest probe cache. */
export function _resetPytestProbeForTesting(): void {
  pytestProbeCache = null
}

/** The framework for a request: explicit wins; else pytest when detected in
 *  the project AND importable; else unittest (stdlib — always viable when
 *  the interpreter is). */
export function resolveFramework(from: string = getCwd(), explicit?: TestFramework): TestFramework {
  if (explicit) return explicit
  const profile = buildPythonProjectProfile(from)
  if (profile.testFrameworks.pytest.detected && probePytest(from).available) return 'pytest'
  return 'unittest'
}

/**
 * The silent-fallback honesty line: pytest CONFIGURED in the project but not
 * importable means the unittest lane is a FALLBACK, not the project's
 * choice — and "unittest: 0 test(s)" alone taught a pytest project nothing
 * about why its tests vanished. Null when there is nothing to explain (no
 * pytest markers, or pytest importable). The caller applies it only when no
 * explicit framework was requested (explicit wins is not a fallback).
 */
export function pytestFallbackNote(from: string = getCwd()): string | null {
  const profile = buildPythonProjectProfile(from)
  if (!profile.testFrameworks.pytest.detected) return null
  const probe = probePytest(from)
  if (probe.available) return null
  return (
    `NOTE: pytest is configured (${profile.testFrameworks.pytest.evidence ?? 'project markers'}) but ${probe.detail} — ` +
    `fell back to unittest. pip install pytest (into the selected interpreter) restores the pytest lane.`
  )
}

// ── the embedded structured reporters ────────────────────────────────────────
// Both emit NDJSON lines `{"t":"case",...}` / `{"t":"collect",...}` to a
// REPORT FILE (fd-safe against test stdout noise) — structure by
// construction, no output parsing.

const PYTEST_PLUGIN_SOURCE = `
import json, time

class MercuryReport:
    def __init__(self, out):
        self.out = out
    def _emit(self, obj):
        self.out.write(json.dumps(obj) + "\\n")
        self.out.flush()
    def pytest_collectreport(self, report):
        if report.failed:
            self._emit({"t": "collect-error", "id": str(report.nodeid), "message": str(report.longrepr)[:800]})
    def pytest_itemcollected(self, item):
        self._emit({"t": "collect", "id": item.nodeid})
    def pytest_runtest_logreport(self, report):
        if report.when == "call" or (report.when == "setup" and report.outcome != "passed"):
            outcome = report.outcome  # passed | failed | skipped
            if report.when == "setup" and report.outcome == "failed":
                outcome = "errored"
            entry = {
                "t": "case",
                "id": report.nodeid,
                "outcome": outcome,
                "durationMs": int(report.duration * 1000),
            }
            if report.longrepr is not None:
                entry["message"] = str(report.longrepr)[:800]
            try:
                path, line, _ = report.location
                entry["file"] = path
                if line is not None:
                    entry["line"] = int(line) + 1
            except Exception:
                pass
            self._emit(entry)

def pytest_configure(config):
    out = open(config.getoption("--mercury-report"), "a")
    config.pluginmanager.register(MercuryReport(out), "mercury-report")

def pytest_addoption(parser):
    parser.addoption("--mercury-report", action="store", default="mercury-report.ndjson")
`

const UNITTEST_RUNNER_SOURCE = `
import json, sys, time, unittest

report_path = sys.argv[1]
mode = sys.argv[2]            # discover | run
start_dir = sys.argv[3]
selection = sys.argv[4:]      # node ids for run (empty = all)

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
if selection:
    suite = unittest.TestSuite()
    for node in selection:
        suite.addTests(loader.loadTestsFromName(node))
else:
    suite = loader.discover(start_dir)

if loader.errors:
    for err in loader.errors:
        emit({"t": "collect-error", "id": "loader", "message": str(err)[:800]})

if mode == "discover":
    for test in iter_tests(suite):
        emit({"t": "collect", "id": test.id()})
    sys.exit(0)

class MercuryResult(unittest.TextTestResult):
    def _entry(self, test, outcome, err=None):
        entry = {"t": "case", "id": test.id(), "outcome": outcome,
                 "durationMs": int((time.time() - getattr(test, "_mercury_t0", time.time())) * 1000)}
        if err is not None:
            entry["message"] = self._exc_info_to_string(err, test)[:800]
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

runner = unittest.TextTestRunner(resultclass=MercuryResult, verbosity=1)
result = runner.run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
`

// ── durable run records ──────────────────────────────────────────────────────
// ONE store for every test framework: the polyglot runner lane (projectRunners,
// services/ide/projectRunners.ts) persists through these same helpers, so
// mercury://test, report and rerun-failed serve every language with zero
// second ledgers.

export function testRunsDir(root: string): string {
  // Sticky at the store root.
  return adoptiveProjectPath(root, 'test-runs')
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
  const { root } = findPythonProjectRoot(from)
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

// ── discovery + runs ─────────────────────────────────────────────────────────

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
    // The shared settle owner: exit-or-deadline, and a forced end takes the
    // whole tree (a `python -m` wrapper's grandchild held the pipes).
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

export interface DiscoverOutcome {
  framework: TestFramework
  tests: string[]
  collectErrors: string[]
  truncated?: number
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
    // PYTHONPATH carries the plugin dir — the SAME ride the run path has
    // always had (executeRun); discovery spawned with the bare env, so
    // `-p mercury_report_plugin` failed to import wherever pytest actually
    // existed and discovery answered unavailable (the gate boxes carry no
    // pytest, so the skipping provers never saw it).
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
    // A project whose own conftest/ini rejects --rootdir still answers:
    // one retry without the pin (the plugin env rides both spawns).
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
  return {
    framework,
    tests: tests.slice(0, cap),
    collectErrors,
    ...(tests.length > cap ? { truncated: tests.length - cap } : {}),
  }
}

export interface RunOptions {
  from?: string
  framework?: TestFramework
  /** Node ids / a file path; empty = the whole suite. */
  selection?: string[]
  selectionLabel?: string
  signal?: AbortSignal
}

let runSeq = 0

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

  // PYTHONPATH carries the plugin dir for the pytest arm (the runner arm is
  // an absolute script path). env spread: the house Bun spawnSync lesson.
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
    .filter(e => e.t === 'case' && e.id && e.outcome)
    .map(e => ({
      id: e.id!,
      outcome: (['passed', 'failed', 'skipped', 'errored'].includes(e.outcome!) ? e.outcome : 'errored') as TestCaseResult['outcome'],
      ...(e.message ? { message: e.message } : {}),
      ...(e.file ? { file: e.file } : {}),
      ...(typeof e.line === 'number' ? { line: e.line } : {}),
      ...(typeof e.durationMs === 'number' ? { durationMs: e.durationMs } : {}),
    }))
  const collectErrors = events.filter(e => e.t === 'collect-error')
  const counts = {
    passed: cases.filter(c => c.outcome === 'passed').length,
    failed: cases.filter(c => c.outcome === 'failed').length,
    skipped: cases.filter(c => c.outcome === 'skipped').length,
    errored: cases.filter(c => c.outcome === 'errored').length + collectErrors.length,
  }
  const failures = cases.filter(c => c.outcome === 'failed' || c.outcome === 'errored').map(c => c.id)

  let verdictNote: string | undefined
  if (cases.length === 0 && collectErrors.length === 0) {
    verdictNote = `no structured case records arrived (exit ${exitCode ?? 'null'}) — the run is EVIDENCE-FREE, treat as errored`
  } else if (exitCode === 0 && failures.length > 0) {
    verdictNote = 'exit code 0 disagreed with recorded failures — structured records win'
  } else if (exitCode !== 0 && exitCode !== null && failures.length === 0 && counts.passed > 0 && collectErrors.length === 0) {
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
    selection: opts?.selectionLabel ?? (sel.length ? `nodes:${sel.join(',')}`.slice(0, 200) : 'all'),
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
    ...(verdictNote ? { verdictNote } : {}),
  }
  try {
    await persistRun(root, record)
  } catch (e) {
    logForDebugging(`pythonTests: run record persistence failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { state: 'ok', record }
}

export async function rerunFailedTests(opts?: { from?: string; signal?: AbortSignal }): Promise<
  TestRunOutcome | { state: 'nothing-to-rerun'; note: string }
> {
  const from = opts?.from ?? getCwd()
  const latest = latestRun(from)
  if (!latest) return { state: 'nothing-to-rerun', note: 'no recorded run yet — run the suite first' }
  if (latest.framework !== 'pytest' && latest.framework !== 'unittest') {
    // The latest record belongs to the polyglot runner lane — the
    // Test tool routes it there; this python path must never misread it.
    return {
      state: 'unavailable',
      reason: `latest run ${latest.id} is a ${latest.framework} run, not a python run`,
      remedy: 'rerun through the runner lane (the Test tool routes rerunFailed by record framework)',
    }
  }
  if (latest.failures.length === 0) {
    return { state: 'nothing-to-rerun', note: `latest run ${latest.id} had no failures — nothing to rerun` }
  }
  return runPythonTests({
    from,
    framework: latest.framework,
    selection: latest.failures,
    selectionLabel: 'rerun-failed',
    ...(opts?.signal ? { signal: opts.signal } : {}),
  })
}

// ── debug one test (the SAME debugpy machinery, via a shim program) ─────────

export interface DebugShim {
  framework: TestFramework
  program: string
  cwd: string
  note: string
}

/** Build the shim program that runs EXACTLY one test node under the debugger.
 *  The shim is the launch target; breakpoints bind in the REAL test files
 *  (debugpy maps by path). */
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
