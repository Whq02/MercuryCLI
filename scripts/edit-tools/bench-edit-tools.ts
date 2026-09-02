#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/bench-edit-tools.ts — the workbench §3 frozen-mission
//  benchmark. Eight deterministic coding missions replayed at TOOL LEVEL
//  through Mercury's real owner seams (fs edit application, change anchors,
//  the python Test owner, cargo/node runners, gitGraph observation, the IDE
//  transaction record, the resource registry, ToolSearch scoring) against
//  DISPOSABLE fixtures — ZERO paid model calls.
//
//  What it measures: journey shape — tool calls by surface,
//  fallback shell calls, failed edit attempts + edit-format re-reads,
//  repeated edit bytes (old_string retransmission), explicit Transaction
//  bookkeeping calls, steps-to-first-green-check, false successes,
//  unresolved refs, exact unavailable states. Wall time is bucketed in the
//  regenerated MD only — the COMMITTED projection
//  (scripts/edit-tools/fixtures/baseline.json · after.json) carries stable counts.
//
//  Modes: --mode baseline (baseline journeys, today's owners only) ·
//  --mode after (the same missions through the shipped workbench surfaces; a
//  mission without an after-path FAILS LOUDLY — no silent fallback).
//  --write persists the projection + MD; without it the run prints only.
//
//  The gate member that runs this and refuses drift is
//  scripts/edit-tools/prove-edit-tools-benchmark.ts. Billed model-driven passes stay
//  OUT of the gate (the gate replays the committed projection only).
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// —— hermetic seams: every side effect off the real config home (F6 law) ————
const repoRoot = resolve(import.meta.dir, '..', '..')
const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'anvil-bench-home-'))
const DAEMON_HOME = mkdtempSync(join(tmpdir(), 'anvil-bench-daemon-'))
if (!process.env.MERCURY_CONFIG_DIR) process.env.MERCURY_CONFIG_DIR = CONFIG_HOME
if (!process.env.MERCURY_DAEMON_DIR) process.env.MERCURY_DAEMON_DIR = DAEMON_HOME

// —— the typed owner seams under measurement ————————————————————————————————
const { applyEditToFile } = await import('../../src/tools/FileEditTool/utils.ts')
const { mintFileAnchor, checkAnchor, formatAnchorFailure } = await import(
  '../../src/services/changeTransaction/snapshotAnchor.ts'
)
const { planHunks, applyHunks } = await import(
  '../../src/services/changeTransaction/hunks.ts'
)
const { discoverRunnerProfiles, runRunnerProfile } = await import(
  '../../src/services/ide/projectRunners.ts'
)
const { _drainTxAutoCaptureForTesting, installTxAutoCapture } = await import(
  '../../src/services/ide/txAutoCapture.ts'
)
const { recordReview } = await import('../../src/services/repoHost/repoHost.ts')
const { installChangeReceiptObserver, receiptsFor, _resetChangeReceiptsForTesting } =
  await import('../../src/services/changeTransaction/receipts.ts')
const { observeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
const {
  discoverPythonTests,
  runPythonTests,
  rerunFailedTests,
  latestRun,
} = await import('../../src/services/ide/pythonTests.ts')
const {
  openTransaction,
  noteStep,
  finishTransaction,
  resumeTransaction,
} = await import('../../src/services/ide/ideTransaction.ts')
const { gitStatus, gitDiff } = await import('../../src/services/gitGraph/observe.ts')
const { resolveResource } = await import('../../src/services/resources/registry.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { searchToolsWithKeywords } = await import(
  '../../src/tools/ToolSearchTool/ToolSearchTool.ts'
)
// register the resource adapters the missions mint / probe refs for
await import('../../src/services/resources/adapters/test.ts')
await import('../../src/services/resources/adapters/git.ts')
await import('../../src/services/resources/adapters/transaction.ts')
await import('../../src/services/resources/adapters/health.ts')
await import('../../src/services/resources/adapters/repo.ts')

type OwnerKey = ReturnType<typeof processMainOwner>
const owner: OwnerKey = processMainOwner()

// ── the per-mission trace ───────────────────────────────────────────────────
export interface MissionMetrics {
  id: string
  title: string
  done: boolean
  /** calls by surface — 'Bash' rows are ALSO counted in fallbackShellCalls
   *  when the shell stands in for a missing typed path */
  toolCalls: Record<string, number>
  totalToolCalls: number
  fallbackShellCalls: number
  failedEditAttempts: number
  editFormatRereads: number
  /** old_string bytes retransmitted to express edits */
  repeatedEditBytes: number
  explicitTxCalls: number
  invalidOrUnavailableCalls: number
  /** calls until the first green targeted check (stable across machines) */
  stepsToFirstGreenCheck: number | null
  falseSuccess: boolean
  unresolvedRefs: number
  duplicateEvidenceRows: number
  operatorInterventions: number
  timeBucket: '<1s' | '1-5s' | '>5s' | 'n/a'
  notes: string[]
}

class Trace {
  m: MissionMetrics
  #t0 = performance.now()
  #steps = 0
  constructor(id: string, title: string) {
    this.m = {
      id,
      title,
      done: false,
      toolCalls: {},
      totalToolCalls: 0,
      fallbackShellCalls: 0,
      failedEditAttempts: 0,
      editFormatRereads: 0,
      repeatedEditBytes: 0,
      explicitTxCalls: 0,
      invalidOrUnavailableCalls: 0,
      stepsToFirstGreenCheck: null,
      falseSuccess: false,
      unresolvedRefs: 0,
      duplicateEvidenceRows: 0,
      operatorInterventions: 0,
      timeBucket: 'n/a',
      notes: [],
    }
  }
  call(surface: string): number {
    this.m.toolCalls[surface] = (this.m.toolCalls[surface] ?? 0) + 1
    this.#steps += 1
    return this.#steps
  }
  shellFallback(what: string): number {
    this.m.fallbackShellCalls += 1
    this.m.notes.push(`fallback shell: ${what}`)
    return this.call('Bash')
  }
  greenCheckAt(step: number): void {
    if (this.m.stepsToFirstGreenCheck === null) this.m.stepsToFirstGreenCheck = step
  }
  note(s: string): void {
    this.m.notes.push(s)
  }
  finish(done: boolean): MissionMetrics {
    this.m.done = done
    this.m.totalToolCalls = Object.values(this.m.toolCalls).reduce((a, b) => a + b, 0)
    const ms = performance.now() - this.#t0
    this.m.timeBucket = ms < 1000 ? '<1s' : ms <= 5000 ? '1-5s' : '>5s'
    return this.m
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
function sh(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function readCounted(t: Trace, file: string): { content: string; anchor: string } {
  t.call('Read')
  const content = readFileSync(file, 'utf8')
  return { content, anchor: mintFileAnchor(content) }
}

/** One baseline Edit call: exact-string replacement through the real
 *  application path, counting the old_string bytes the model retransmits. */
function editCounted(
  t: Trace,
  file: string,
  oldString: string,
  newString: string,
): boolean {
  t.call('Edit')
  t.m.repeatedEditBytes += Buffer.byteLength(oldString, 'utf8')
  const before = readFileSync(file, 'utf8')
  if (!before.includes(oldString)) {
    t.m.failedEditAttempts += 1
    return false
  }
  writeFileSync(file, applyEditToFile(before, oldString, newString))
  return true
}

const cleanups: Array<() => void> = []
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `anvil-${label}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ── fixtures ───────────────────────────────────────────────────────────────
function buildTsFixture(): string {
  const dir = tempDir('ts')
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'test'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'anvil-ts-fixture',
        private: true,
        type: 'module',
        scripts: { test: 'node --test test/calc.test.ts' },
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(
    join(dir, 'src', 'calc.ts'),
    [
      'export function add(a: number, b: number): number {',
      '  return a - b', // seeded defect 1
      '}',
      '',
      'export function max(a: number, b: number): number {',
      '  return a < b ? a : b', // seeded defect 2
      '}',
      '',
      'export function clamp(v: number, lo: number, hi: number): number {',
      '  return Math.min(hi, Math.max(lo, v))',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(dir, 'src', 'stats.ts'),
    [
      "import { max } from './calc.ts'",
      '',
      'export function peak(values: number[]): number {',
      '  return values.reduce((a, b) => max(a, b), Number.NEGATIVE_INFINITY)',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(dir, 'test', 'calc.test.ts'),
    [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { add, max } from '../src/calc.ts'",
      "import { peak } from '../src/stats.ts'",
      '',
      "test('add', () => { assert.equal(add(2, 3), 5) })",
      "test('max', () => { assert.equal(max(2, 3), 3) })",
      "test('peak', () => { assert.equal(peak([1, 9, 4]), 9) })",
      '',
    ].join('\n'),
  )
  return dir
}

function buildPyFixture(): string {
  const dir = tempDir('py')
  mkdirSync(join(dir, 'mylib'))
  mkdirSync(join(dir, 'tests'))
  writeFileSync(join(dir, 'mylib', '__init__.py'), '')
  writeFileSync(
    join(dir, 'mylib', 'core.py'),
    ['def clamp01(x):', '    return x', ''].join('\n'), // defect: no clamping
  )
  writeFileSync(join(dir, 'tests', '__init__.py'), '')
  writeFileSync(
    join(dir, 'tests', 'test_core.py'),
    [
      'import unittest',
      '',
      'from mylib.core import clamp01',
      '',
      '',
      'class TestClamp(unittest.TestCase):',
      '    def test_inside(self):',
      '        self.assertEqual(clamp01(0.5), 0.5)',
      '',
      '    def test_above(self):',
      '        self.assertEqual(clamp01(1.5), 1.0)',
      '',
      '',
      "if __name__ == '__main__':",
      '    unittest.main()',
      '',
    ].join('\n'),
  )
  return dir
}

function buildRustFixture(): string | null {
  const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) return null
  const dir = tempDir('rs')
  mkdirSync(join(dir, 'src'))
  writeFileSync(
    join(dir, 'Cargo.toml'),
    ['[package]', 'name = "anvil_rs"', 'version = "0.1.0"', 'edition = "2021"', ''].join(
      '\n',
    ),
  )
  writeFileSync(
    join(dir, 'src', 'lib.rs'),
    [
      'pub fn mid(a: i32, b: i32) -> i32 {',
      '    a + (b - a) / 3', // seeded defect: / 3
      '}',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    use super::mid;',
      '',
      '    #[test]',
      '    fn mid_of_range() {',
      '        assert_eq!(mid(0, 10), 5);',
      '    }',
      '}',
      '',
    ].join('\n'),
  )
  return dir
}

function buildMixedFixture(): { dir: string } {
  const dir = tempDir('mixed')
  writeFileSync(join(dir, 'a.txt'), 'alpha\nbeta\ngamma\n')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'b.md'), '# b\n')
  writeFileSync(join(dir, 'sub', 'c.json'), '{"c":1}\n')
  writeFileSync(join(dir, 'sub', 'n1.txt'), 'n1\n')
  writeFileSync(
    join(dir, 'note.ipynb'),
    JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          source: ['print(1)'],
          outputs: [],
          execution_count: null,
          metadata: {},
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }) + '\n',
  )
  return { dir }
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  HOME: CONFIG_HOME,
}
function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=anvil', '-c', 'user.email=anvil@bench', ...args],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
  )
}

function buildRepoFixture(): { dir: string; shimDir: string } {
  const dir = tempDir('repo')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'app.js'), 'export const version = 1\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'app.js'), 'export const version = 2\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'bump version')
  git(dir, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'feature.js'), 'export function feat() { return true }\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'add feature')
  // deterministic gh shim — answers the exact queries the mission makes
  const shimDir = tempDir('ghshim')
  const prJson = JSON.stringify({
    number: 1,
    title: 'add feature',
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'feature',
    body: 'Adds feat().',
    files: [{ path: 'feature.js', additions: 1, deletions: 0 }],
  })
  const checksText = 'gate\tpass\t1m2s\thttps://ci.example/run/1\n'
  writeFileSync(
    join(shimDir, 'gh'),
    [
      '#!/usr/bin/env bash',
      '# deterministic gh shim — repository fixture answers only',
      'case "$1 $2" in',
      `  "pr view") printf '%s\\n' '${prJson}' ;;`,
      `  "pr checks") printf '%s' '${checksText}' ;;`,
      '  "auth status") echo "Logged in (shim)" ;;',
      '  *) echo "gh shim: unsupported: $*" >&2; exit 1 ;;',
      'esac',
    ].join('\n'),
  )
  chmodSync(join(shimDir, 'gh'), 0o755)
  return { dir, shimDir }
}

// ── missions (baseline journeys through today's owners) ────────────────────
type Mode = 'baseline' | 'after'

async function m1TsDefect(mode: Mode): Promise<MissionMetrics> {
  const t = new Trace('m1-ts-defect', 'TypeScript defect: locate → two-hunk edit → targeted check')
  const dir = buildTsFixture()
  // seeded RED first — the check instrument must actually catch the defect
  const red = sh('node', ['--test', 'test/calc.test.ts'], dir)
  if (red.ok) {
    t.note('FIXTURE BROKEN: seeded defect did not fail the test')
    return t.finish(false)
  }
  t.call('Grep') // locate the responsible symbol
  const calc = join(dir, 'src', 'calc.ts')
  const { content, anchor } = readCounted(t, calc)

  if (mode === 'after') {
    // ONE anchored multi-hunk Edit call — zero old_string retransmission
    t.call('Edit')
    const plan = planHunks(
      content,
      [
        { lines: '2', replace: '  return a + b' },
        { lines: '6', replace: '  return a < b ? b : a' },
      ],
      anchor,
    )
    if (!plan.ok) {
      t.note(`hunks plan refused: ${plan.message}`)
      return t.finish(false)
    }
    const anchorCheck = checkAnchor(anchor, readFileSync(calc, 'utf8'), calc)
    if (!anchorCheck.ok) return t.finish(false)
    writeFileSync(calc, applyHunks(content, plan))
    // typed check through the runner lane — no shell fallback
    const step = t.call('Test')
    const profile = discoverRunnerProfiles(dir).profiles.find(
      p => p.runner === 'node-test' && p.kind === 'test',
    )
    if (!profile) {
      t.note('no node-test profile discovered')
      return t.finish(false)
    }
    const out = await runRunnerProfile(profile, { from: dir })
    const green = out.state === 'ok' && out.record.counts.failed === 0 && out.record.exitCode === 0
    if (green) t.greenCheckAt(step)
    return t.finish(green)
  }

  // two hunks in one file — baseline pays TWO Edit calls with full old bodies
  const ok1 = editCounted(t, calc, '  return a - b', '  return a + b')
  const ok2 = editCounted(t, calc, '  return a < b ? a : b', '  return a < b ? b : a')
  const step = t.shellFallback('node --test (no typed JS/TS runner today)')
  const green = sh('node', ['--test', 'test/calc.test.ts'], dir)
  if (green.ok) t.greenCheckAt(step)
  return t.finish(ok1 && ok2 && green.ok)
}

async function m2PyDefect(mode: Mode): Promise<MissionMetrics> {
  const t = new Trace('m2-py-defect', 'Python defect: failing test → patch → targeted rerun')
  if (mode === 'after') t.note('ALREADY STRONG — the after journey is the identical typed python path')
  const dir = buildPyFixture()
  t.call('Test')
  const discovered = await discoverPythonTests({ from: dir })
  if (!discovered || (discovered as { state?: string }).state === 'unavailable') {
    t.m.invalidOrUnavailableCalls += 1
    t.note('python test discovery unavailable')
    return t.finish(false)
  }
  t.call('Test')
  const run1 = await runPythonTests({ from: dir })
  const failed1 = run1.state === 'ok' && run1.record.counts.failed > 0
  if (!failed1) {
    t.note('FIXTURE BROKEN: seeded defect did not fail')
    return t.finish(false)
  }
  const core = join(dir, 'mylib', 'core.py')
  readCounted(t, core)
  const okEdit = editCounted(t, core, '    return x', '    return min(1.0, max(0.0, x))')
  t.call('Test')
  const rerun = await rerunFailedTests({ from: dir })
  const rerunGreen = rerun.state === 'ok' && rerun.record.counts.failed === 0
  const step = t.call('Test')
  const full = await runPythonTests({ from: dir })
  const fullGreen = full.state === 'ok' && full.record.counts.failed === 0
  if (fullGreen) t.greenCheckAt(step)
  // the typed run must mint a resolvable mercury://test ref (adapter reads cwd)
  const rec = latestRun(dir)
  if (rec) {
    const res = await runWithCwdOverride(dir, () =>
      resolveResource(`mercury://test/run/${rec.id}`, { owner, cwd: dir }),
    )
    if (res.state !== 'ok') {
      t.m.unresolvedRefs += 1
      t.note(`mercury://test/run/${rec.id} did not resolve: ${res.state}`)
    }
  }
  return t.finish(okEdit && rerunGreen && fullGreen)
}

async function m3RustDefect(mode: Mode): Promise<MissionMetrics> {
  const t = new Trace('m3-rust-defect', 'Rust defect: locate → edit → targeted cargo check')
  const dir = buildRustFixture()
  if (!dir) {
    t.note('UNAVAILABLE: cargo not on PATH — honest unavailable row (mission 3)')
    t.m.timeBucket = 'n/a'
    return t.finish(false)
  }
  const cargoEnv = { CARGO_TARGET_DIR: join(dir, 'target') }
  const lib = join(dir, 'src', 'lib.rs')

  if (mode === 'after') {
    // typed cargo lane end to end — zero shell fallbacks
    process.env.CARGO_TARGET_DIR = join(dir, 'target')
    try {
      const profile = discoverRunnerProfiles(dir).profiles.find(
        p => p.runner === 'cargo' && p.kind === 'test',
      )
      if (!profile || profile.availability.state !== 'ok') {
        t.note('UNAVAILABLE: cargo profile not runnable')
        return t.finish(false)
      }
      let step = t.call('Test')
      const red = await runRunnerProfile(profile, { from: dir })
      if (!(red.state === 'ok' && red.record.counts.failed === 1)) {
        t.note('FIXTURE BROKEN: seeded defect did not fail the typed run')
        return t.finish(false)
      }
      const { anchor, content } = readCounted(t, lib)
      t.call('Edit')
      const plan = planHunks(content, [{ lines: '2', replace: '    a + (b - a) / 2' }], anchor)
      if (!plan.ok) return t.finish(false)
      writeFileSync(lib, applyHunks(content, plan))
      step = t.call('Test')
      const green = await runRunnerProfile(profile, { from: dir })
      const ok = green.state === 'ok' && green.record.counts.failed === 0 && green.record.exitCode === 0
      if (ok) t.greenCheckAt(step)
      return t.finish(ok)
    } finally {
      delete process.env.CARGO_TARGET_DIR
    }
  }

  let step = t.shellFallback('cargo test (no typed Rust runner today)')
  const red = sh('cargo', ['test', '-q'], dir, cargoEnv)
  if (red.ok) {
    t.note('FIXTURE BROKEN: seeded defect did not fail cargo test')
    return t.finish(false)
  }
  readCounted(t, lib)
  const okEdit = editCounted(t, lib, '    a + (b - a) / 3', '    a + (b - a) / 2')
  step = t.shellFallback('cargo test rerun (no typed Rust runner today)')
  const green = sh('cargo', ['test', '-q'], dir, cargoEnv)
  if (green.ok) t.greenCheckAt(step)
  return t.finish(okEdit && green.ok)
}

async function m4Rename(mode: Mode): Promise<MissionMetrics> {
  const t = new Trace('m4-rename', 'Rename journey: symbol + file across references')
  const dir = buildTsFixture()
  // fix the seeded defects first so the final check isolates the rename
  const calc = join(dir, 'src', 'calc.ts')
  writeFileSync(
    join(dir, 'src', 'calc.ts'),
    readFileSync(calc, 'utf8')
      .replace('return a - b', 'return a + b')
      .replace('return a < b ? a : b', 'return a < b ? b : a'),
  )
  t.call('Grep') // find references to max(
  const stats = join(dir, 'src', 'stats.ts')
  const test = join(dir, 'test', 'calc.test.ts')
  const rCalc = readCounted(t, calc)
  const rStats = readCounted(t, stats)
  const rTest = readCounted(t, test)

  if (mode === 'after') {
    // one anchored multi-hunk Edit call PER FILE — zero old_string bytes
    t.call('Edit')
    const p1 = planHunks(rCalc.content, [{ lines: '5', replace: 'export function maxOf(a: number, b: number): number {' }], rCalc.anchor)
    t.call('Edit')
    const p2 = planHunks(
      rStats.content,
      [
        { lines: '1', replace: "import { maxOf } from './calculator.ts'" },
        { lines: '4', replace: '  return values.reduce((a, b) => maxOf(a, b), Number.NEGATIVE_INFINITY)' },
      ],
      rStats.anchor,
    )
    t.call('Edit')
    const p3 = planHunks(
      rTest.content,
      [
        { lines: '3', replace: "import { add, maxOf } from '../src/calculator.ts'" },
        { lines: '7', replace: "test('max', () => { assert.equal(maxOf(2, 3), 3) })" },
      ],
      rTest.anchor,
    )
    if (!p1.ok || !p2.ok || !p3.ok) {
      t.note('a rename plan refused')
      return t.finish(false)
    }
    writeFileSync(calc, applyHunks(rCalc.content, p1))
    writeFileSync(stats, applyHunks(rStats.content, p2))
    writeFileSync(test, applyHunks(rTest.content, p3))
    t.shellFallback('mv src/calc.ts src/calculator.ts (file rename stays a shell move in this journey)')
    renameSync(calc, join(dir, 'src', 'calculator.ts'))
    const step = t.call('Test')
    const profile = discoverRunnerProfiles(dir).profiles.find(
      p => p.runner === 'node-test' && p.kind === 'test',
    )
    if (!profile) return t.finish(false)
    const out = await runRunnerProfile(profile, { from: dir })
    const ok = out.state === 'ok' && out.record.counts.failed === 0 && out.record.exitCode === 0
    if (ok) t.greenCheckAt(step)
    return t.finish(ok)
  }

  // symbol rename max → maxOf: one Edit per hunk at baseline
  const e1 = editCounted(
    t,
    calc,
    'export function max(a: number, b: number): number {',
    'export function maxOf(a: number, b: number): number {',
  )
  const e2 = editCounted(t, stats, "import { max } from './calc.ts'", "import { maxOf } from './calculator.ts'")
  const e3 = editCounted(t, stats, 'values.reduce((a, b) => max(a, b)', 'values.reduce((a, b) => maxOf(a, b)')
  const e4 = editCounted(t, test, "import { add, max } from '../src/calc.ts'", "import { add, maxOf } from '../src/calculator.ts'")
  const e5 = editCounted(t, test, "test('max', () => { assert.equal(max(2, 3), 3) })", "test('max', () => { assert.equal(maxOf(2, 3), 3) })")
  // file rename calc.ts → calculator.ts: baseline = shell mv
  t.shellFallback('mv src/calc.ts src/calculator.ts (no typed pathRename in this journey)')
  renameSync(calc, join(dir, 'src', 'calculator.ts'))
  const step = t.shellFallback('node --test (no typed JS/TS runner today)')
  const green = sh('node', ['--test', 'test/calc.test.ts'], dir)
  if (green.ok) t.greenCheckAt(step)
  return t.finish(e1 && e2 && e3 && e4 && e5 && green.ok)
}

async function m5Drift(mode: Mode): Promise<MissionMetrics> {
  const t = new Trace('m5-drift', 'Drift journey: stale edit refused exactly, recovery without damage')
  if (mode === 'after') t.note('ALREADY STRONG — the anchor law is unchanged by construction')
  const dir = tempDir('drift')
  const file = join(dir, 'config.ts')
  writeFileSync(file, 'export const port = 3000\nexport const host = "localhost"\nexport const retries = 3\n')
  const { anchor } = readCounted(t, file)
  // the file changes underneath (concurrent/delegated work)
  writeFileSync(file, 'export const port = 3001\nexport const host = "localhost"\nexport const retries = 3\n')
  // stale edit attempt carrying expected_anchor — must refuse EXACTLY, write nothing
  t.call('Edit')
  t.m.repeatedEditBytes += Buffer.byteLength('export const port = 3000', 'utf8')
  const check = checkAnchor(anchor, readFileSync(file, 'utf8'), file)
  if (check.ok) {
    t.m.falseSuccess = true
    t.note('DRIFT NOT DETECTED — anchor law broken')
    return t.finish(false)
  }
  t.m.failedEditAttempts += 1
  const msg = formatAnchorFailure(check, anchor)
  if (!/Stale anchor/.test(msg) || !/Reread:/.test(msg)) {
    t.note(`refusal message lost its exact shape: ${msg.slice(0, 80)}`)
    return t.finish(false)
  }
  const bytesAfterRefusal = readFileSync(file, 'utf8')
  if (!bytesAfterRefusal.includes('port = 3001')) {
    t.note('refusal wrote bytes — data-loss class')
    return t.finish(false)
  }
  // recovery: re-read (the reread hint), then the corrected edit applies
  t.m.editFormatRereads += 1
  readCounted(t, file)
  const ok = editCounted(t, file, 'export const retries = 3', 'export const retries = 5')
  const final = readFileSync(file, 'utf8')
  const undamaged = final.includes('port = 3001') && final.includes('host = "localhost"')
  return t.finish(ok && undamaged)
}

async function m6MixedTargets(mode: Mode): Promise<MissionMetrics> {
  const t = new Trace('m6-mixed-targets', 'Mixed-target reading: file · directory · notebook · resource · HTTP doc')
  const { dir } = buildMixedFixture()
  const surfaces = new Set<string>()
  // 1. local text file — Read
  readCounted(t, join(dir, 'a.txt'))
  surfaces.add('Read')
  if (mode === 'after') {
    // 2. directory — the S1 front door serves it as a Read target
    t.call('Read')
    const { renderDirectoryTarget } = await import('../../src/tools/FileReadTool/readTarget.ts')
    const listing = renderDirectoryTarget(join(dir, 'sub'))
    if (!listing.content.includes('(target: directory')) return t.finish(false)
    surfaces.add('Read')
    // 3. notebook — Read (unchanged)
    t.call('Read')
    // 4. mercury:// resource — ALSO a Read target now (typed state)
    t.call('Read')
    const { renderResourceTarget } = await import('../../src/tools/FileReadTool/readTarget.ts')
    const res = await runWithCwdOverride(dir, () =>
      renderResourceTarget('mercury://doctor/latest', { owner, cwd: dir }),
    )
    if (!/state: (ok|absent|unavailable)/.test(res.content)) return t.finish(false)
    t.note(`resource served through the Read front door: ${res.content.split('\n')[0]}`)
    // 5. HTTP document — WebFetch (the front door names the delegation)
    const http = await import('node:http')
    const server = http.createServer((_req, res2) => {
      res2.writeHead(200, { 'content-type': 'text/html' })
      res2.end('<html><body><h1>doc</h1></body></html>')
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    t.call('WebFetch')
    surfaces.add('WebFetch')
    const doc = await fetch(`http://127.0.0.1:${port}/doc.html`).then(r => r.text())
    server.close()
    if (!doc.includes('doc')) return t.finish(false)
    t.note(`surfaces used: ${[...surfaces].join(' + ')} (${surfaces.size} distinct for 5 targets)`)
    return t.finish(true)
  }
  // 2. directory — TODAY the Read prompt steers to shell ls
  t.shellFallback('ls (Read refuses directories; prompt says use Bash ls)')
  const ls = sh('ls', ['-1', 'sub'], dir)
  if (!ls.ok) return t.finish(false)
  surfaces.add('Bash')
  // 3. notebook — Read handles .ipynb natively (counted; parser not re-proved here)
  t.call('Read')
  surfaces.add('Read')
  t.note('notebook counted at the Read surface (parser exercised by its own suite)')
  // 4. mercury:// resource — Inspect owner; absent must be a TYPED state, not prose
  t.call('Inspect')
  surfaces.add('Inspect')
  const res = await resolveResource('mercury://doctor/latest', { owner, cwd: dir })
  if (res.state === 'unavailable') {
    t.m.invalidOrUnavailableCalls += 1
    t.note(`doctor ref unavailable: ${'note' in res ? res.note : ''}`)
  } else {
    t.note(`mercury://doctor/latest → typed state '${res.state}' (absent-vs-ok both exact)`)
  }
  // 5. HTTP document — WebFetch owner (loopback fixture; delegation counted)
  const http = await import('node:http')
  const server = http.createServer((_req, res2) => {
    res2.writeHead(200, { 'content-type': 'text/html' })
    res2.end('<html><body><h1>doc</h1></body></html>')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  t.call('WebFetch')
  surfaces.add('WebFetch')
  const doc = await fetch(`http://127.0.0.1:${port}/doc.html`).then(r => r.text())
  server.close()
  if (!doc.includes('doc')) return t.finish(false)
  t.note(`surfaces used: ${[...surfaces].join(' + ')} (${surfaces.size} distinct for 5 targets)`)
  return t.finish(true)
}

async function m7Repository(mode: Mode): Promise<MissionMetrics> {
  const t = new Trace('m7-repository', 'Repository journey: branch/commit → PR + checks → located review')
  const { dir, shimDir } = buildRepoFixture()
  const shimEnv = { PATH: `${shimDir}:${process.env.PATH}` }
  // typed local observation — already owned (sync; unavailable is the only miss)
  t.call('Git')
  const st = gitStatus(dir)
  if ('state' in st && st.state === 'unavailable') {
    t.note(`gitStatus unavailable: ${st.note ?? ''}`)
    return t.finish(false)
  }
  t.call('Git')
  const diff = gitDiff(dir, { scope: 'worktree' })
  if ('state' in diff && diff.state === 'unavailable') {
    t.note(`gitDiff unavailable: ${diff.note ?? ''}`)
    return t.finish(false)
  }

  if (mode === 'after') {
    // host context through the mercury://repo plane (shim on PATH) —
    // no shell fallbacks; the review lands as a TYPED record
    const { _resetRepoHostCacheForTesting } = await import('../../src/services/repoHost/repoHost.ts')
    const priorPath = process.env.PATH
    process.env.PATH = `${shimDir}:${priorPath}`
    _resetRepoHostCacheForTesting()
    try {
      t.call('Inspect')
      const pr = await resolveResource('mercury://repo/pr/1', { owner, cwd: dir })
      if (pr.state !== 'ok' || !('resource' in pr) || !(pr.resource.text ?? '').includes('Adds feat().')) {
        t.note(`repo/pr resolve: ${pr.state}`)
        return t.finish(false)
      }
      const step = t.call('Inspect')
      const checks = await resolveResource('mercury://repo/checks/1', { owner, cwd: dir })
      if (checks.state !== 'ok' || !('resource' in checks) || !(checks.resource.text ?? '').includes('pass')) {
        t.note(`repo/checks resolve: ${checks.state}`)
        return t.finish(false)
      }
      t.greenCheckAt(step)
      t.call('Git') // op:"reviewRecord" — the typed findings record
      const rec = await recordReview({
        root: dir,
        scope: 'pr#1',
        inspected: ['feature.js'],
        findings: [
          {
            class: 'defect',
            severity: 'major',
            path: 'feature.js',
            range: 'L1',
            claim: 'feat() lands without a test',
            evidence: 'PR file list shows feature.js only',
            nextAction: 'add a regression test before merge',
          },
        ],
        allowedPaths: ['feature.js'],
      })
      if (rec.state !== 'ok') {
        t.note(`review record: ${rec.state === 'refused' ? rec.reason : ''}`)
        return t.finish(false)
      }
      t.note('review = TYPED findings record at mercury://repo/review/latest')
      return t.finish(true)
    } finally {
      process.env.PATH = priorPath
      _resetRepoHostCacheForTesting()
    }
  }
  // host context — TODAY only raw shell gh
  let step = t.shellFallback('gh pr view (no repository-host resource kind today)')
  const pr = sh('gh', ['pr', 'view', '--json', 'number,title,state'], dir, shimEnv)
  if (!pr.ok || !pr.out.includes('add feature')) return t.finish(false)
  step = t.shellFallback('gh pr checks (no repository-host resource kind today)')
  const checks = sh('gh', ['pr', 'checks'], dir, shimEnv)
  if (!checks.ok || !checks.out.includes('pass')) return t.finish(false)
  t.greenCheckAt(step)
  // review composition — untyped prose at baseline; no findings contract
  t.note('review = hand-composed prose; no typed findings/severity/range surface today')
  return t.finish(true)
}

async function m8ClosedLoop(mode: Mode): Promise<MissionMetrics> {
  const t = new Trace('m8-closed-loop', 'Closed loop: transaction → edit → stabilize → test → resume → truthful finish')
  const dir = buildPyFixture()
  _resetChangeReceiptsForTesting()
  installChangeReceiptObserver()

  if (mode === 'after') {
    // S4 auto-capture: open / resume / finish are the ONLY explicit calls
    installTxAutoCapture()
    t.call('Transaction')
    t.m.explicitTxCalls += 1
    const tx = await openTransaction({ owner, intent: 'fix clamp01 range defect', from: dir })
    const core = join(dir, 'mylib', 'core.py')
    readCounted(t, core)
    const okEdit = editCounted(t, core, '    return x', '    return min(1.0, max(0.0, x))')
    const now = Date.now()
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: 'anvil-m8-after-edit',
      input: { file_path: core },
      ok: true,
      durationMs: 5,
      effect: {
        outcome: 'succeeded',
        operation: 'file.edit',
        changedPaths: [core],
        evidence: 'benchmark edit applied through applyEditToFile',
        startedAt: now - 5,
        completedAt: now,
      },
      cwd: dir,
    })
    const stepT = t.call('Test')
    const run = await runPythonTests({ from: dir })
    if (!(run.state === 'ok' && run.record.counts.failed === 0)) return t.finish(false)
    observeToolTerminal({
      owner,
      toolName: 'Test',
      toolUseId: 'anvil-m8-after-test',
      input: { op: 'run' },
      ok: true,
      durationMs: 40,
      effect: {
        outcome: 'succeeded',
        operation: 'test.run',
        changedPaths: [],
        evidence: `unittest green (${run.record.id})`,
        startedAt: now,
        completedAt: Date.now(),
      },
      cwd: dir,
    })
    await _drainTxAutoCaptureForTesting()
    t.call('Transaction')
    t.m.explicitTxCalls += 1
    const resume = await runWithCwdOverride(dir, () => resumeTransaction({ id: tx.id, owner, from: dir }))
    if (!resume || resume.applyRefChecks.some(c => !c.resolves)) {
      t.m.unresolvedRefs += 1
      return t.finish(false)
    }
    const stepF = t.call('Transaction')
    t.m.explicitTxCalls += 1
    const fin = await runWithCwdOverride(dir, () =>
      finishTransaction({ id: tx.id, owner, verdict: 'completed', from: dir }),
    )
    if (fin.state !== 'ok') {
      t.note(`finish refused: ${fin.state === 'refused' ? fin.reason : ''}`)
      return t.finish(false)
    }
    t.greenCheckAt(stepF)
    const autoRows = fin.record.steps.filter(s => s.auto)
    const dup = new Set(autoRows.map(s => `${s.auto!.toolUseId}:${s.kind}`))
    if (dup.size !== autoRows.length) t.m.duplicateEvidenceRows += autoRows.length - dup.size
    t.note(`auto rows: ${autoRows.map(s => s.kind).join(', ')} — explicit calls: open/resume/finish only`)
    void stepT
    return t.finish(okEdit)
  }
  t.call('Transaction')
  t.m.explicitTxCalls += 1
  const tx = await openTransaction({ owner, intent: 'fix clamp01 range defect', from: dir })
  // the real edit + the real exactly-once terminal observation (mints the receipt)
  const core = join(dir, 'mylib', 'core.py')
  readCounted(t, core)
  const okEdit = editCounted(t, core, '    return x', '    return min(1.0, max(0.0, x))')
  const now = Date.now()
  observeToolTerminal({
    owner,
    toolName: 'Edit',
    toolUseId: 'anvil-m8-edit-1',
    input: { file_path: core },
    ok: true,
    durationMs: 5,
    effect: {
      outcome: 'succeeded',
      operation: 'file.edit',
      changedPaths: [core],
      evidence: 'benchmark edit applied through applyEditToFile',
      startedAt: now - 5,
      completedAt: now,
    },
    cwd: dir,
  })
  const receipts = receiptsFor(owner)
  const receipt = receipts[receipts.length - 1]
  if (!receipt) {
    t.note('no ChangeReceipt minted from the terminal observation')
    return t.finish(false)
  }
  if (receipts.length !== 1) t.m.duplicateEvidenceRows += receipts.length - 1
  // baseline ceremony: every step noted BY HAND
  t.call('Transaction')
  t.m.explicitTxCalls += 1
  const s1 = await runWithCwdOverride(dir, () =>
    noteStep({
      id: tx.id,
      owner,
      kind: 'apply',
      summary: 'patched clamp01 to clamp into [0,1]',
      refs: [`mercury://receipt/${receipt.id}`],
      from: dir,
    }),
  )
  if (s1.state !== 'ok') {
    t.m.unresolvedRefs += 1
    t.note(`apply note refused: ${s1.state === 'refused' ? s1.reason : ''}`)
    return t.finish(false)
  }
  t.call('Transaction')
  t.m.explicitTxCalls += 1
  const s2 = await noteStep({
    id: tx.id,
    owner,
    kind: 'stabilize',
    summary: 'no diagnostics provider in fixture — stabilization vacuous',
    outcome: 'ok',
    from: dir,
  })
  if (s2.state !== 'ok') return t.finish(false)
  t.call('Test')
  const run = await runPythonTests({ from: dir })
  const green = run.state === 'ok' && run.record.counts.failed === 0
  if (!green) {
    t.note('fixture test did not go green after the patch')
    return t.finish(false)
  }
  t.call('Transaction')
  t.m.explicitTxCalls += 1
  const s3 = await runWithCwdOverride(dir, () =>
    noteStep({
      id: tx.id,
      owner,
      kind: 'test',
      summary: 'unittest suite green after patch',
      refs: [`mercury://test/run/${run.record.id}`],
      outcome: 'ok',
      from: dir,
    }),
  )
  if (s3.state !== 'ok') {
    t.m.unresolvedRefs += 1
    return t.finish(false)
  }
  // interrupt/resume — liveness re-verified, nothing replayed
  t.call('Transaction')
  t.m.explicitTxCalls += 1
  const resume = await runWithCwdOverride(dir, () =>
    resumeTransaction({ id: tx.id, owner, from: dir }),
  )
  if (!resume || resume.applyRefChecks.some(c => !c.resolves)) {
    t.m.unresolvedRefs += resume ? resume.applyRefChecks.filter(c => !c.resolves).length : 1
    t.note('resume found dead apply refs')
    return t.finish(false)
  }
  const stepCount = t.call('Transaction')
  t.m.explicitTxCalls += 1
  const fin = await finishTransaction({ id: tx.id, owner, verdict: 'completed', from: dir })
  if (fin.state !== 'ok') {
    t.note(`finish refused: ${fin.state === 'refused' ? fin.reason : ''} — completion law intact but journey incomplete`)
    return t.finish(false)
  }
  t.greenCheckAt(stepCount)
  // duplicate-evidence audit: exactly one receipt, exactly one apply row
  const applyRows = fin.record.steps.filter(s => s.kind === 'apply')
  if (applyRows.length !== 1) t.m.duplicateEvidenceRows += applyRows.length - 1
  return t.finish(okEdit)
}

// ── the ToolSearch intent corpus (committed — §12 rank threshold) ──────────
interface IntentProbe {
  id: string
  query: string
  /** the surface that SHOULD serve this intent at each phase */
  wantBaseline: string
  wantAfter: string
}
const INTENTS: IntentProbe[] = [
  { id: 'intent-read-file', query: 'read a source file with line numbers', wantBaseline: 'Read', wantAfter: 'Read' },
  { id: 'intent-open-directory', query: 'open this directory and list what is inside', wantBaseline: 'Bash', wantAfter: 'Read' },
  { id: 'intent-read-resource', query: 'read this mercury:// resource reference', wantBaseline: 'Inspect', wantAfter: 'Read' },
  { id: 'intent-fetch-document', query: 'fetch this https document and read its content', wantBaseline: 'WebFetch', wantAfter: 'WebFetch' },
  { id: 'intent-run-js-tests', query: 'run the javascript test suite and rerun failures', wantBaseline: 'Test', wantAfter: 'Test' },
  { id: 'intent-run-cargo-test', query: 'run cargo test for one failing rust test', wantBaseline: 'Test', wantAfter: 'Test' },
  { id: 'intent-pr-context', query: 'show the pull request, its changed files and checks for this branch', wantBaseline: 'Git', wantAfter: 'Git' },
]

async function probeIntents(mode: Mode): Promise<Array<{ id: string; want: string; rank: number | null; top: string[] }>> {
  const catalog = getAllBaseTools()
  const rows: Array<{ id: string; want: string; rank: number | null; top: string[] }> = []
  for (const probe of INTENTS) {
    const want = mode === 'baseline' ? probe.wantBaseline : probe.wantAfter
    // searchToolsWithKeywords returns ranked tool NAMES
    const names = (await searchToolsWithKeywords(probe.query, catalog, catalog, 5)) as string[]
    const idx = names.indexOf(want)
    rows.push({ id: probe.id, want, rank: idx >= 0 ? idx + 1 : null, top: names.slice(0, 3) })
  }
  return rows
}

// ── runner ─────────────────────────────────────────────────────────────────
const MISSIONS: Array<{ id: string; run: (mode: Mode) => Promise<MissionMetrics> }> = [
  { id: 'm1-ts-defect', run: m1TsDefect },
  { id: 'm2-py-defect', run: m2PyDefect },
  { id: 'm3-rust-defect', run: m3RustDefect },
  { id: 'm4-rename', run: m4Rename },
  { id: 'm5-drift', run: m5Drift },
  { id: 'm6-mixed-targets', run: m6MixedTargets },
  { id: 'm7-repository', run: m7Repository },
  { id: 'm8-closed-loop', run: m8ClosedLoop },
]

export async function runCorpus(mode: Mode): Promise<{
  missions: MissionMetrics[]
  intents: Awaited<ReturnType<typeof probeIntents>>
}> {
  const missions: MissionMetrics[] = []
  for (const m of MISSIONS) {
    try {
      missions.push(await m.run(mode))
    } catch (err) {
      const t = new Trace(m.id, `${m.id} (crashed)`)
      t.note(`CRASH: ${err instanceof Error ? err.message : String(err)}`)
      missions.push(t.finish(false))
    }
  }
  const intents = await probeIntents(mode)
  return { missions, intents }
}

// stable projection — counts only, no timings (those go to the MD buckets)
function stableProjection(r: Awaited<ReturnType<typeof runCorpus>>, mode: Mode) {
  return {
    program: 'anvil',
    section: '§3 frozen missions',
    mode,
    fixtures: 'disposable (mkdtemp, outside the repo tree); gh = deterministic shim; cargo/node/python = machine toolchain',
    missions: r.missions.map(m => ({
      id: m.id,
      title: m.title,
      done: m.done,
      toolCalls: m.toolCalls,
      totalToolCalls: m.totalToolCalls,
      fallbackShellCalls: m.fallbackShellCalls,
      failedEditAttempts: m.failedEditAttempts,
      editFormatRereads: m.editFormatRereads,
      repeatedEditBytes: m.repeatedEditBytes,
      explicitTxCalls: m.explicitTxCalls,
      invalidOrUnavailableCalls: m.invalidOrUnavailableCalls,
      stepsToFirstGreenCheck: m.stepsToFirstGreenCheck,
      falseSuccess: m.falseSuccess,
      unresolvedRefs: m.unresolvedRefs,
      duplicateEvidenceRows: m.duplicateEvidenceRows,
      operatorInterventions: m.operatorInterventions,
      notes: m.notes,
    })),
    intents: r.intents,
  }
}

function renderMd(r: Awaited<ReturnType<typeof runCorpus>>, mode: Mode): string {
  const lines: string[] = []
  lines.push(`# workbench §3 ${mode.toUpperCase()} — frozen-mission measurements`)
  lines.push('')
  lines.push('_Generated by `bun run scripts/edit-tools/bench-edit-tools.ts --mode ' + mode + ' --write`. Do not hand-edit. Counts are the committed projection; wall time is bucketed here only._')
  lines.push('')
  lines.push('| Mission | Done | Calls | Shell fallbacks | Failed edits | Re-reads | Edit bytes | Tx calls | Steps→green | False succ | Unresolved | Time |')
  lines.push('|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|')
  for (const m of r.missions) {
    lines.push(
      `| \`${m.id}\` | ${m.done ? 'yes' : 'NO'} | ${m.totalToolCalls} | ${m.fallbackShellCalls} | ${m.failedEditAttempts} | ${m.editFormatRereads} | ${m.repeatedEditBytes} | ${m.explicitTxCalls} | ${m.stepsToFirstGreenCheck ?? '—'} | ${m.falseSuccess ? 'YES' : 'no'} | ${m.unresolvedRefs} | ${m.timeBucket} |`,
    )
  }
  lines.push('')
  lines.push('## ToolSearch intent corpus')
  lines.push('')
  lines.push('| Intent | Wanted surface | Rank | Top 3 |')
  lines.push('|---|---|:--:|---|')
  for (const i of r.intents) {
    lines.push(`| \`${i.id}\` | ${i.want} | ${i.rank ?? 'MISS'} | ${i.top.join(', ')} |`)
  }
  lines.push('')
  lines.push('## Mission notes')
  lines.push('')
  for (const m of r.missions) {
    if (m.notes.length === 0) continue
    lines.push(`- **${m.id}**: ${m.notes.join(' · ')}`)
  }
  lines.push('')
  return lines.join('\n')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const mode: Mode = args.includes('--mode')
    ? (args[args.indexOf('--mode') + 1] as Mode)
    : 'baseline'
  if (mode !== 'baseline' && mode !== 'after') {
    console.error(`unknown mode '${mode}' — use baseline|after`)
    process.exit(2)
  }
  const write = args.includes('--write')
  const result = await runCorpus(mode)
  const md = renderMd(result, mode)
  console.log(md)
  if (write) {
    const outDir = join(repoRoot, 'scripts', 'edit-tools', 'fixtures')
    mkdirSync(outDir, { recursive: true })
    const jsonName = mode === 'baseline' ? 'baseline.json' : 'after.json'
    const mdName = mode === 'baseline' ? 'BASELINE.md' : 'AFTER.md'
    writeFileSync(join(outDir, jsonName), JSON.stringify(stableProjection(result, mode), null, 2) + '\n')
    writeFileSync(join(outDir, mdName), md)
    console.log(`wrote ${join(outDir, jsonName)} + ${mdName}`)
  }
  for (const c of cleanups) c()
  const failed = result.missions.filter(m => !m.done && !m.notes.some(n => n.startsWith('UNAVAILABLE')))
  if (failed.length > 0) {
    console.error(`\n${failed.length} mission(s) incomplete: ${failed.map(m => m.id).join(', ')}`)
    process.exit(1)
  }
}
