// ============================================================================
//  ide/projectRunners — the polyglot check/test/build runner
//  registry. Extends the EXISTING Test/Launch owners' discovery seams; it is
//  not a second executor and never a generic command wrapper:
//
//    · discovery is MANIFEST-DRIVEN only — package.json (declared vitest/
//      jest, node --test scripts, bounded *.test.* presence), Cargo.toml,
//      go.mod. No guessed commands, no package-manager guesswork (the PM
//      comes from a lockfile or the packageManager field; no signal ⇒ a
//      typed unavailable profile naming that), never an install;
//    · profile ids are CONTENT-STABLE (`rp-<sha256-12>` over source manifest
//      path + runner + kind + argv) — a changed manifest changes the id and
//      a stale id gets an exact stale-profile result;
//    · execution is argv-only (execFile, never a shell), bounded output,
//      timeout + abort kill the child; a non-zero/signal exit can NEVER
//      summarize as success; parseable summaries (node:test TAP · cargo)
//      fill counts + failing node names, unparseable ones record an honest
//      verdictNote instead of invented counts;
//    · every run persists into the ONE test-run record store
//      (pythonTests.persistTestRun) — mercury://test, report and
//      rerun-failed serve these records with zero new ledgers.
//
//  Availability is explicit per profile: missing runner binary, missing
//  node_modules, missing lockfile all carry an exact remedy. Gate: the
//  EXISTING MERCURY_TESTS (discovery+run) / MERCURY_LAUNCH (profile listing)
//  owners — this module adds no flag.
//
//  Proof: scripts/edit-tools/prove-project-runners.ts (suite scripts/edit-tools/).
// ============================================================================

import { spawn } from 'node:child_process'
import { settleChildRun } from '../../utils/childSettle.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { storeArtifact } from '../../utils/artifacts/store.js'
import {
  latestRun,
  persistTestRun,
  pythonTestsEnabled,
  type RunnerFramework,
  type TestCaseResult,
  type TestRunRecord,
} from './pythonTests.js'

export type RunnerKind = 'test' | 'check' | 'build'

export interface RunnerProfile {
  /** Content-stable id: rp-<sha256-12> over manifest+runner+kind+argv. */
  id: string
  runner: RunnerFramework
  kind: RunnerKind
  title: string
  /** The manifest that declared this profile (relative to root). */
  source: string
  root: string
  /** Exact argv (argv[0] = binary). Never passed through a shell. */
  command: string[]
  /** Selection support: how `file`/`node` map onto extra argv. */
  selection: 'node-pattern' | 'file' | 'cargo-filter' | 'go-pattern' | 'none'
  availability:
    | { state: 'ok' }
    | { state: 'unavailable'; reason: string; remedy: string }
}

const RUN_TIMEOUT_MS = 300_000
const OUTPUT_TAIL_LINES = 40
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const TEST_FILE_SCAN_CAP = 400

function profileId(parts: string[]): string {
  return `rp-${createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 12)}`
}

/** PATH resolution with where.exe semantics on win32: PATHEXT applies to a
 *  bare name — cargo/go/node ship ONLY cargo.exe/go.exe/node.exe with no
 *  extensionless sibling, so the old bare-name existsSync never saw an
 *  installed toolchain and every Rust/Go/`node --test` profile hard-refused
 *  with an install remedy forever (TASK-017 S2,
 *  runner-availability-ignores-pathext; the same lesson healthReport's gh
 *  row records from TASK-014 w4-f16-03). Zero spawns — pure fs probes.
 *  Exported with injectable env/platform for the availability prover. */
export function resolveRunnerBinary(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | null {
  const paths = (env.PATH ?? '').split(path.delimiter)
  // PATHEXT entries are conventionally UPPERCASE while the files on disk are
  // lowercase (.exe): a case-folding filesystem hits either spelling, but a
  // case-sensitive one (a dev worktree, a network mount) needs both probed —
  // lowercase FIRST so the returned spelling matches the conventional
  // on-disk name, bare name before any extension.
  const exts = ['']
  if (platform === 'win32') {
    for (const raw of (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')) {
      if (raw.length === 0) continue
      const lower = raw.toLowerCase()
      if (!exts.includes(lower)) exts.push(lower)
      if (!exts.includes(raw)) exts.push(raw)
    }
  }
  for (const p of paths) {
    if (!p) continue
    for (const ext of exts) {
      const full = path.join(p, bin + ext)
      try {
        if (existsSync(full)) return full
      } catch {
        /* keep scanning */
      }
    }
  }
  return null
}

function which(bin: string): string | null {
  return resolveRunnerBinary(bin)
}

// ── discovery ───────────────────────────────────────────────────────────────

/** Find the nearest directory at-or-above `from` holding any runner manifest. */
export function findRunnerRoot(from: string = getCwd()): string | null {
  let dir = path.resolve(from)
  for (let i = 0; i < 24; i++) {
    if (
      existsSync(path.join(dir, 'package.json')) ||
      existsSync(path.join(dir, 'Cargo.toml')) ||
      existsSync(path.join(dir, 'go.mod'))
    ) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

function detectPackageManager(root: string): { bin: string } | { missing: string } {
  if (existsSync(path.join(root, 'bun.lock')) || existsSync(path.join(root, 'bun.lockb'))) return { bin: 'bun' }
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return { bin: 'pnpm' }
  if (existsSync(path.join(root, 'yarn.lock'))) return { bin: 'yarn' }
  if (existsSync(path.join(root, 'package-lock.json'))) return { bin: 'npm' }
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { packageManager?: string }
    const pm = pkg.packageManager?.split('@')[0]
    if (pm === 'bun' || pm === 'npm' || pm === 'pnpm' || pm === 'yarn') return { bin: pm }
  } catch {
    /* fall through */
  }
  return { missing: 'no lockfile and no packageManager field — declare one; Mercury never guesses a package manager' }
}

function binaryAvailability(bin: string, remedy: string): RunnerProfile['availability'] {
  return which(bin) ? { state: 'ok' } : { state: 'unavailable', reason: `'${bin}' not on PATH`, remedy }
}

/** Bounded scan for *.test.* / *_test.go style files (depth 2, capped). */
function hasTestFiles(root: string, patterns: RegExp, dirs: string[]): boolean {
  let seen = 0
  const scan = (dir: string, depth: number): boolean => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const e of entries) {
      if (++seen > TEST_FILE_SCAN_CAP) return false
      if (e.isFile() && patterns.test(e.name)) return true
      if (e.isDirectory() && depth > 0 && !e.name.startsWith('.') && e.name !== 'node_modules') {
        if (scan(path.join(dir, e.name), depth - 1)) return true
      }
    }
    return false
  }
  for (const d of dirs) {
    const p = d === '.' ? root : path.join(root, d)
    if (existsSync(p) && scan(p, 2)) return true
  }
  return false
}

function jsProfiles(root: string): RunnerProfile[] {
  const pkgPath = path.join(root, 'package.json')
  if (!existsSync(pkgPath)) return []
  let pkg: {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return []
  }
  const profiles: RunnerProfile[] = []
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const testScript = pkg.scripts?.test ?? ''

  if (deps.vitest !== undefined) {
    const bin = path.join(root, 'node_modules', '.bin', 'vitest')
    profiles.push({
      id: profileId([pkgPath, 'vitest', 'test']),
      runner: 'vitest',
      kind: 'test',
      title: 'vitest (declared)',
      source: 'package.json',
      root,
      command: [bin, 'run'],
      selection: 'file',
      availability: existsSync(bin)
        ? { state: 'ok' }
        : { state: 'unavailable', reason: 'vitest is declared but node_modules/.bin/vitest is missing', remedy: 'install the project dependencies with the declared package manager' },
    })
  } else if (deps.jest !== undefined) {
    const bin = path.join(root, 'node_modules', '.bin', 'jest')
    profiles.push({
      id: profileId([pkgPath, 'jest', 'test']),
      runner: 'jest',
      kind: 'test',
      title: 'jest (declared)',
      source: 'package.json',
      root,
      command: [bin],
      selection: 'file',
      availability: existsSync(bin)
        ? { state: 'ok' }
        : { state: 'unavailable', reason: 'jest is declared but node_modules/.bin/jest is missing', remedy: 'install the project dependencies with the declared package manager' },
    })
  } else if (
    /\bnode\s+(--experimental-strip-types\s+)?--test\b/.test(testScript) ||
    hasTestFiles(root, /\.test\.(m?[jt]s|[jt]sx)$/, ['test', 'tests', 'src', '.'])
  ) {
    profiles.push({
      id: profileId([pkgPath, 'node-test', 'test']),
      runner: 'node-test',
      kind: 'test',
      title: 'node --test',
      source: 'package.json',
      root,
      // reporter pinned: the default is TTY-dependent, tap is the parseable contract
      command: ['node', '--test', '--test-reporter', 'tap'],
      selection: 'node-pattern',
      availability: binaryAvailability('node', 'install Node.js ≥ 20'),
    })
  }

  // declared scripts as typed check/build profiles (bounded, named set only)
  const pm = detectPackageManager(root)
  for (const [script, kind] of [
    ['build', 'build'],
    ['check', 'check'],
    ['lint', 'check'],
    ['typecheck', 'check'],
  ] as const) {
    if (!pkg.scripts?.[script]) continue
    const availability: RunnerProfile['availability'] =
      'missing' in pm
        ? { state: 'unavailable', reason: 'package manager undeclared', remedy: pm.missing }
        : binaryAvailability(pm.bin, `install ${pm.bin} (declared by the project's lockfile/packageManager)`)
    profiles.push({
      id: profileId([pkgPath, 'script', script]),
      runner: 'node-test',
      kind,
      title: `${'missing' in pm ? 'npm' : pm.bin} run ${script}`,
      source: 'package.json',
      root,
      command: 'missing' in pm ? ['npm', 'run', script] : [pm.bin, 'run', script],
      selection: 'none',
      availability,
    })
  }
  return profiles
}

function cargoProfiles(root: string): RunnerProfile[] {
  const manifest = path.join(root, 'Cargo.toml')
  if (!existsSync(manifest)) return []
  const availability = binaryAvailability('cargo', 'install the Rust toolchain (rustup)')
  const mk = (kind: RunnerKind, argv: string[], title: string, selection: RunnerProfile['selection']): RunnerProfile => ({
    id: profileId([manifest, 'cargo', kind]),
    runner: 'cargo',
    kind,
    title,
    source: 'Cargo.toml',
    root,
    command: argv,
    selection,
    availability,
  })
  return [
    // no -q on test: quiet mode suppresses the per-test FAILED lines the
    // failure parser (and rerun-failed) depend on
    mk('test', ['cargo', 'test'], 'cargo test', 'cargo-filter'),
    mk('check', ['cargo', 'check', '-q'], 'cargo check', 'none'),
    mk('build', ['cargo', 'build', '-q'], 'cargo build', 'none'),
  ]
}

function goProfiles(root: string): RunnerProfile[] {
  const manifest = path.join(root, 'go.mod')
  if (!existsSync(manifest)) return []
  const availability = binaryAvailability('go', 'install the Go toolchain')
  const mk = (kind: RunnerKind, argv: string[], title: string, selection: RunnerProfile['selection']): RunnerProfile => ({
    id: profileId([manifest, 'go', kind]),
    runner: 'go',
    kind,
    title,
    source: 'go.mod',
    root,
    command: argv,
    selection,
    availability,
  })
  return [
    mk('test', ['go', 'test', './...'], 'go test ./...', 'go-pattern'),
    mk('build', ['go', 'build', './...'], 'go build ./...', 'none'),
  ]
}

export function discoverRunnerProfiles(from: string = getCwd()): {
  root: string | null
  profiles: RunnerProfile[]
} {
  if (!pythonTestsEnabled()) return { root: null, profiles: [] }
  const root = findRunnerRoot(from)
  if (!root) return { root: null, profiles: [] }
  return { root, profiles: [...jsProfiles(root), ...cargoProfiles(root), ...goProfiles(root)] }
}

// ── execution ───────────────────────────────────────────────────────────────

let runSeq = 0

function parseNodeTestTap(out: string): {
  counts: TestRunRecord['counts'] | null
  failures: string[]
} {
  const failures: string[] = []
  for (const m of out.matchAll(/^not ok \d+ - (.+?)(?: #.*)?$/gm)) {
    failures.push(m[1]!.trim())
  }
  const tests = /^# tests (\d+)$/m.exec(out)
  const pass = /^# pass (\d+)$/m.exec(out)
  const fail = /^# fail (\d+)$/m.exec(out)
  const skipped = /^# skipped (\d+)$/m.exec(out)
  const cancelled = /^# cancelled (\d+)$/m.exec(out)
  if (!tests || !pass || !fail) return { counts: null, failures }
  return {
    counts: {
      passed: Number(pass[1]),
      failed: Number(fail[1]) + (cancelled ? Number(cancelled[1]) : 0),
      skipped: skipped ? Number(skipped[1]) : 0,
      errored: 0,
    },
    failures,
  }
}

function parseCargoTest(out: string): {
  counts: TestRunRecord['counts'] | null
  failures: string[]
} {
  const failures: string[] = []
  for (const m of out.matchAll(/^test (\S+) \.\.\. FAILED$/gm)) {
    failures.push(m[1]!)
  }
  let passed = 0
  let failed = 0
  let ignored = 0
  let sawSummary = false
  for (const m of out.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm)) {
    sawSummary = true
    passed += Number(m[1])
    failed += Number(m[2])
    ignored += Number(m[3])
  }
  if (!sawSummary) return { counts: null, failures }
  return { counts: { passed, failed, skipped: ignored, errored: 0 }, failures }
}

// ── failure normalization ─────────────────────────────────
// Typed failed-case rows (file · line · test name · summary) parsed from
// each runner's output. Parsers are BEST-EFFORT and bounded: what does not
// parse simply yields no case row — counts/verdicts stay the authority and
// verdictNote already names count-parse absence. Pure functions (proof
// fixtures feed captured output directly).

const CASE_PARSE_CAP = 50

function relIfUnder(root: string, p: string): string {
  if (!path.isAbsolute(p)) return p
  const rel = path.relative(root, p)
  if (!rel.startsWith('..')) return rel
  // Symlinked temp roots (macOS /var → /private/var) report realpathed
  // child locations — compare against the realpathed root too.
  try {
    const realRel = path.relative(require('node:fs').realpathSync(root), p)
    if (!realRel.startsWith('..')) return realRel
  } catch {
    /* keep the absolute path */
  }
  return p
}

export function parseRunnerCases(runner: RunnerFramework, out: string, root: string): TestCaseResult[] {
  const cases: TestCaseResult[] = []
  const push = (c: TestCaseResult): void => {
    if (cases.length < CASE_PARSE_CAP) cases.push(c)
  }
  switch (runner) {
    case 'node-test': {
      // TAP: `not ok N - name` + YAML diag block (location: '<p>:<l>:<c>',
      // error: '<msg>').
      const lines = out.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*not ok \d+ - (.+?)(?: #.*)?$/.exec(lines[i]!)
        if (!m) continue
        const row: TestCaseResult = { id: m[1]!.trim(), outcome: 'failed' }
        for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
          const line = lines[j]!
          if (/^\s*(not )?ok \d+ /.test(line)) break
          const loc = /location:\s*'([^']+):(\d+):\d+'/.exec(line)
          if (loc) {
            row.file = relIfUnder(root, loc[1]!)
            row.line = Number(loc[2])
          }
          if (row.message === undefined) {
            // error: 'msg' (inline) or error: |- / error: > (YAML block —
            // the message is the next non-empty line).
            const inline = /error:\s*['"](.+?)['"]\s*$/.exec(line)
            if (inline) {
              row.message = inline[1]!.slice(0, 300)
            } else if (/^\s*error:\s*[|>][+-]?\s*$/.test(line)) {
              const next = lines[j + 1]?.trim()
              if (next) row.message = next.slice(0, 300)
            }
          }
        }
        push(row)
      }
      return cases
    }
    case 'cargo': {
      // `---- name stdout ----` sections; `panicked at <file>:<l>:<c>:`
      // (new format) or `panicked at '<msg>', <file>:<l>:<c>` (old).
      const sections = out.split(/^---- (\S+) stdout ----$/m)
      for (let i = 1; i + 1 < sections.length; i += 2) {
        const name = sections[i]!
        const body = sections[i + 1]!
        const row: TestCaseResult = { id: name, outcome: 'failed' }
        const modern = /panicked at ([^\s:]+\.rs):(\d+):\d+:\n?([^\n]*)/.exec(body)
        const legacy = /panicked at '([^']*)',\s*([^\s:]+\.rs):(\d+):\d+/.exec(body)
        if (modern) {
          row.file = relIfUnder(root, modern[1]!)
          row.line = Number(modern[2])
          if (modern[3]?.trim()) row.message = modern[3]!.trim().slice(0, 300)
        } else if (legacy) {
          row.message = legacy[1]!.slice(0, 300)
          row.file = relIfUnder(root, legacy[2]!)
          row.line = Number(legacy[3])
        }
        push(row)
      }
      return cases
    }
    case 'go': {
      // `--- FAIL: TestName` + indented ` file_test.go:12: message`.
      const lines = out.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*--- FAIL: (\S+)/.exec(lines[i]!)
        if (!m) continue
        const row: TestCaseResult = { id: m[1]!, outcome: 'failed' }
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const loc = /^\s+([\w./-]+\.go):(\d+):\s*(.*)$/.exec(lines[j]!)
          if (loc) {
            row.file = loc[1]!
            row.line = Number(loc[2])
            if (loc[3]?.trim()) row.message = loc[3]!.trim().slice(0, 300)
            break
          }
        }
        push(row)
      }
      return cases
    }
    case 'vitest': {
      // ` FAIL src/x.test.ts > suite > name` + ` ❯ src/x.test.ts:5:10`.
      const lines = out.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:×|✕|FAIL)\s+(\S+\.[cm]?[jt]sx?) > (.+)$/.exec(lines[i]!.replace(/\x1b\[[0-9;]*m/g, ''))
        if (!m) continue
        push({ id: m[2]!.trim(), outcome: 'failed', file: relIfUnder(root, m[1]!) })
      }
      return cases
    }
    case 'jest': {
      // `● suite › name` + `at … (src/x.test.ts:5:3)`. Non-failure `●`
      // blocks (Console echoes, Validation/Deprecation warnings) are NOT
      // failed cases — a green run must never grow phantom failure rows.
      const clean = out.replace(/\x1b\[[0-9;]*m/g, '')
      const lines = clean.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*● (.+)$/.exec(lines[i]!)
        if (!m) continue
        const header = m[1]!.trim()
        if (header.startsWith('Test suite failed') || header === 'Console' || /^(Validation|Deprecation) Warning/.test(header)) {
          continue
        }
        const row: TestCaseResult = { id: header.replace(/ › /g, ' > '), outcome: 'failed' }
        for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
          const loc = /at .*\(([^)]+?\.[cm]?[jt]sx?):(\d+):\d+\)/.exec(lines[j]!)
          if (loc) {
            row.file = relIfUnder(root, loc[1]!)
            row.line = Number(loc[2])
            break
          }
        }
        push(row)
      }
      return cases
    }
    default:
      return cases
  }
}

// ── changed-file-focused selection ─────────────────────────

export type ChangedSelection =
  | { state: 'ok'; argv: string[]; label: string; changedCount: number }
  | { state: 'unavailable'; reason: string; remedy: string }

/**
 * Map the working tree's changed files onto a runner-native focused run
 * (the runner's OWN related-test machinery where it has one; changed test
 * files where it does not; an HONEST decline where the runner cannot select
 * by file at all). No git ⇒ typed unavailable, never a guessed full run.
 */
export function changedRunnerSelection(profile: RunnerProfile): ChangedSelection {
  let changed: string[]
  try {
    const { gitStatus } = require('../gitGraph/observe.js') as typeof import('../gitGraph/observe.js')
    const s = gitStatus(profile.root)
    if ('state' in s) {
      return { state: 'unavailable', reason: s.note, remedy: 'changed-file selection needs a git repository' }
    }
    // Only files that still EXIST can be run targets — a deleted test file
    // in the argv would turn a healthy tree into a phantom red run.
    changed = s.files.map(f => f.path).filter(p => existsSync(path.join(profile.root, p)))
  } catch (err) {
    return { state: 'unavailable', reason: `git status failed: ${(err as Error).message}`, remedy: 'check the repository state' }
  }
  if (changed.length === 0) {
    return { state: 'unavailable', reason: 'the working tree is clean — no changed files to focus on', remedy: 'run the full profile instead' }
  }
  const bin = profile.command[0]!
  switch (profile.runner) {
    case 'vitest': {
      // vitest's own related-test resolution over the changed source set.
      const sources = changed.filter(f => /\.[cm]?[jt]sx?$/.test(f))
      if (sources.length === 0) {
        return { state: 'unavailable', reason: 'no changed JS/TS files', remedy: 'run the full profile instead' }
      }
      return { state: 'ok', argv: [bin, 'related', ...sources.slice(0, 40), '--run'], label: 'changed', changedCount: sources.length }
    }
    case 'jest': {
      const sources = changed.filter(f => /\.[cm]?[jt]sx?$/.test(f))
      if (sources.length === 0) {
        return { state: 'unavailable', reason: 'no changed JS/TS files', remedy: 'run the full profile instead' }
      }
      return { state: 'ok', argv: [bin, '--findRelatedTests', ...sources.slice(0, 40)], label: 'changed', changedCount: sources.length }
    }
    case 'node-test': {
      // node --test has no related-test machinery — run the CHANGED TEST
      // FILES exactly (an honest subset, never a guessed mapping).
      const testFiles = changed.filter(f => /\.test\.(m?[jt]s|[jt]sx)$/.test(f))
      if (testFiles.length === 0) {
        return {
          state: 'unavailable',
          reason: 'no changed *.test.* files (node --test cannot map sources to related tests)',
          remedy: 'run the full profile, or pass path/node explicitly',
        }
      }
      return { state: 'ok', argv: [...profile.command, ...testFiles.slice(0, 40)], label: 'changed', changedCount: testFiles.length }
    }
    case 'go': {
      const pkgs = [...new Set(changed.filter(f => f.endsWith('.go')).map(f => path.dirname(f)))]
      if (pkgs.length === 0) {
        return { state: 'unavailable', reason: 'no changed .go files', remedy: 'run the full profile instead' }
      }
      return {
        state: 'ok',
        argv: ['go', 'test', ...pkgs.slice(0, 20).map(p => (p === '.' ? '.' : `./${p}`))],
        label: 'changed',
        changedCount: pkgs.length,
      }
    }
    case 'cargo':
      return {
        state: 'unavailable',
        reason: 'cargo test selects by NAME filter, not by file — a changed-file mapping would be a guess',
        remedy: 'run the full profile, or pass node:<name-filter>',
      }
    default:
      return { state: 'unavailable', reason: `runner '${profile.runner}' has no changed-file selection`, remedy: 'run the full profile' }
  }
}

export interface RunnerRunOptions {
  from?: string
  /** Extra selection: a test-name pattern or file, per profile.selection. */
  selection?: string
  selectionLabel?: string
  /** Full argv override (the changed-selection/rerun seams build these). */
  argvOverride?: string[]
  /** Streamed bounded progress: a BOUNDED live view (never the full
   *  buffer — O(n) per run, not per chunk). */
  onOutput?: (view: { tail: string; lines: number }, elapsedMs: number) => void
  signal?: AbortSignal
  /** Wall-clock budget for the run; past it the process TREE is ended and
   *  the record says so. Defaults to RUN_TIMEOUT_MS. */
  timeoutMs?: number
  /** Extra environment for the child (proof fixtures; the base env is
   *  always the curated subprocess env). */
  env?: Record<string, string>
}

export type RunnerRunOutcome =
  | { state: 'ok'; record: TestRunRecord }
  | { state: 'unavailable'; reason: string; remedy: string }
  | { state: 'stale-profile'; reason: string; profiles: RunnerProfile[] }

export async function runRunnerProfile(
  profileIdOrProfile: string | RunnerProfile,
  opts: RunnerRunOptions = {},
): Promise<RunnerRunOutcome> {
  const from = opts.from ?? getCwd()
  let profile: RunnerProfile
  if (typeof profileIdOrProfile === 'string') {
    const { profiles } = discoverRunnerProfiles(from)
    const found = profiles.find(p => p.id === profileIdOrProfile)
    if (!found) {
      return {
        state: 'stale-profile',
        reason: `no runner profile '${profileIdOrProfile}' in the current discovery — the manifest changed or the id is stale`,
        profiles,
      }
    }
    profile = found
  } else {
    profile = profileIdOrProfile
  }
  if (profile.availability.state !== 'ok') {
    return { state: 'unavailable', reason: profile.availability.reason, remedy: profile.availability.remedy }
  }

  let argv = [...profile.command]
  let selectionLabel = 'all'
  if (opts.argvOverride) {
    // The changed-selection seam owns the full argv (runner-native focused
    // runs re-shape the base command).
    argv = [...opts.argvOverride]
    selectionLabel = opts.selectionLabel ?? 'changed'
  } else if (opts.selection) {
    switch (profile.selection) {
      case 'node-pattern':
        argv.push('--test-name-pattern', opts.selection)
        break
      case 'file':
        argv.push(opts.selection)
        break
      case 'cargo-filter':
        argv.push(opts.selection)
        break
      case 'go-pattern':
        argv.splice(argv.length - 1, 0, '-run', opts.selection)
        break
      case 'none':
        return {
          state: 'unavailable',
          reason: `profile '${profile.title}' does not support a selection`,
          remedy: 'run the profile without file/node, or pick a test profile',
        }
    }
    selectionLabel = opts.selectionLabel ?? `nodes:${opts.selection}`
  }

  const startedAt = Date.now()
  const id = `run-${startedAt}-rp${++runSeq}`
  const bin = argv[0]!
  // spawn (not execFile): the output streams — bounded progress reaches the
  // caller while the run is live. Buffering is BYTE-accurate: whole chunks
  // accumulate (one decode at close — multibyte never splits), the HEAD and
  // TAIL are kept when the cap trips (the end-of-stream summary lines are
  // exactly what the count parsers need), and the gap is marked loudly.
  const HEAD_CAP = MAX_OUTPUT_BYTES / 4
  const TAIL_CAP = MAX_OUTPUT_BYTES - HEAD_CAP
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS
  const result = await (async (): Promise<{ combined: string; code: number | null; errMsg?: string }> => {
    const headChunks: Buffer[] = []
    const tailChunks: Buffer[] = []
    let headBytes = 0
    let tailBytes = 0
    let droppedBytes = 0
    let lineCount = 0
    const child = spawn(bin, argv.slice(1), {
      windowsHide: true,
      cwd: profile.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...subprocessEnv(), CI: process.env.CI ?? '1', NO_COLOR: '1', ...(opts.env ?? {}) },
    })
    const append = (chunk: Buffer): void => {
      for (const b of chunk) if (b === 0x0a) lineCount++
      if (headBytes < HEAD_CAP) {
        headChunks.push(chunk)
        headBytes += chunk.length
      } else {
        tailChunks.push(chunk)
        tailBytes += chunk.length
        while (tailBytes > TAIL_CAP && tailChunks.length > 1) {
          const dropped = tailChunks.shift()!
          tailBytes -= dropped.length
          droppedBytes += dropped.length
        }
      }
      // Progress view: the current chunk's tail only (bounded; a live
      // status line tolerates a chunk-boundary glyph).
      opts.onOutput?.(
        { tail: chunk.subarray(Math.max(0, chunk.length - 2048)).toString('utf8'), lines: lineCount },
        Date.now() - startedAt,
      )
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    // The ONE settle owner: settle on the child's own exit inside a bounded
    // drain (a grandchild holding the inherited pipes must never hold the
    // turn), and let the deadline or the operator's abort end the whole
    // TREE before settling — a root-only kill left the descendants running.
    const settlement = await settleChildRun(child, {
      timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    const head = Buffer.concat(headChunks).toString('utf8')
    const tail = Buffer.concat(tailChunks).toString('utf8')
    const errMsg = settlement.spawnError
      ? settlement.spawnError
      : settlement.timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s — the run was abandoned and its process tree ended`
        : settlement.aborted
          ? 'the run was interrupted — its process tree was ended'
          : settlement.signal
            ? `killed by ${settlement.signal}`
            : undefined
    // A forced end reports NO exit code: the run never reached one.
    const code = settlement.timedOut || settlement.aborted ? null : settlement.code
    return {
      combined:
        droppedBytes > 0
          ? `${head}\n[output truncated: ${droppedBytes} byte(s) dropped mid-stream — head and tail retained]\n${tail}`
          : head + tail,
      code,
      ...(errMsg !== undefined && code === null ? { errMsg } : {}),
    }
  })()

  const combined = result.combined
  const parsed =
    profile.runner === 'node-test'
      ? parseNodeTestTap(combined)
      : profile.runner === 'cargo'
        ? parseCargoTest(combined)
        : { counts: null, failures: [] as string[] }

  const exitOk = result.code === 0 && !result.errMsg
  const failedByCounts = parsed.counts !== null && parsed.counts.failed > 0
  const verdictNotes: string[] = []
  if (parsed.counts === null && profile.kind === 'test') {
    verdictNotes.push(`counts not parsed for ${profile.runner} — exit state is the only verdict`)
  }
  if (result.errMsg) verdictNotes.push(`runner did not exit cleanly: ${result.errMsg}`)
  if (exitOk && failedByCounts) verdictNotes.push('exit code 0 disagreed with parsed failures — treated as FAILED')

  // Family 3: typed failed-case rows (file · line · name · summary).
  // A GREEN run keeps zero rows regardless of what the best-effort parser
  // saw — prose echoes must never poison failures/rerun-failed.
  const runFailed = result.code !== 0 || Boolean(result.errMsg)
  const cases = runFailed ? parseRunnerCases(profile.runner, combined, profile.root) : []

  // Full output behind a durable ref when the tail cannot carry it
  // (parity with the python lane).
  const outputLines = combined.split('\n')
  let outputArtifactRef: string | undefined
  if (outputLines.length > OUTPUT_TAIL_LINES) {
    try {
      const { id: artifactId } = await storeArtifact({
        scope: 'test',
        name: id,
        content: combined,
        kind: 'test-output',
      })
      if (artifactId) outputArtifactRef = `mercury://artifact/test/${artifactId}`
    } catch {
      /* the bounded tail still ships — the ref is additive */
    }
  }

  // Available LSP diagnostics compose into the result; absence is a named
  // note, never a prerequisite.
  let diagnosticsNote: string | undefined
  try {
    const { getPendingLSPDiagnosticCount } =
      require('../lsp/LSPDiagnosticRegistry.js') as typeof import('../lsp/LSPDiagnosticRegistry.js')
    diagnosticsNote = `${getPendingLSPDiagnosticCount()} pending LSP diagnostic(s)`
  } catch {
    /* no live diagnostics provider — omitted, never invented */
  }

  const record: TestRunRecord = {
    schema: 1,
    id,
    framework: profile.runner,
    selection: selectionLabel,
    command: argv,
    cwd: profile.root,
    interpreter: which(bin) ?? bin,
    startedAt,
    durationMs: Date.now() - startedAt,
    counts: parsed.counts ?? { passed: 0, failed: exitOk ? 0 : 1, skipped: 0, errored: result.errMsg ? 1 : 0 },
    cases,
    failures: parsed.failures.length > 0 ? parsed.failures : runFailed ? cases.map(c => c.id) : [],
    ...(outputArtifactRef ? { outputArtifactRef } : {}),
    outputTail: outputLines.slice(-OUTPUT_TAIL_LINES),
    exitCode: result.code,
    ...(verdictNotes.length > 0 ? { verdictNote: verdictNotes.join(' · ') } : {}),
    ...(diagnosticsNote ? { diagnosticsNote } : {}),
  }
  await persistTestRun(profile.root, record)
  return { state: 'ok', record }
}

// ── lane resolution (the Test tool's routing seam) ──────────────────────────

export type TestLane =
  | { lane: 'python'; framework?: 'pytest' | 'unittest' }
  | { lane: 'runner'; profile: RunnerProfile }
  | { lane: 'runner-missing'; runner: string }
  | { lane: 'ambiguous'; options: string[] }

/** Python-project signals — when present, the python lane keeps its exact
 *  pre-S3 default (compatibility law). */
export function hasPythonSignal(from: string = getCwd()): boolean {
  const root = findRunnerRoot(from) ?? path.resolve(from)
  for (const f of ['pyproject.toml', 'setup.py', 'setup.cfg', 'conftest.py']) {
    if (existsSync(path.join(root, f))) return true
  }
  return hasTestFiles(root, /(^test_.*|_test)\.py$/, ['tests', 'test', '.'])
}

/**
 * Route a Test-tool call: explicit frameworks win; otherwise python signals
 * keep the default, else the single discovered runner language, else
 * a NAMED ambiguity (never a guess).
 */
export function resolveTestLane(from: string = getCwd(), explicit?: string): TestLane {
  if (explicit === 'pytest' || explicit === 'unittest') {
    return { lane: 'python', framework: explicit }
  }
  const { profiles } = discoverRunnerProfiles(from)
  const testProfiles = profiles.filter(p => p.kind === 'test')
  if (explicit) {
    const match = testProfiles.find(p => p.runner === explicit)
    return match ? { lane: 'runner', profile: match } : { lane: 'runner-missing', runner: explicit }
  }
  if (hasPythonSignal(from)) return { lane: 'python' }
  if (testProfiles.length === 0) return { lane: 'python' }
  const runners = [...new Set(testProfiles.map(p => p.runner))]
  if (runners.length === 1) return { lane: 'runner', profile: testProfiles[0]! }
  return { lane: 'ambiguous', options: runners }
}

/** Rerun exactly the failing nodes of a prior runner record. */
export async function rerunRunnerFailures(
  record: TestRunRecord,
  opts: { from?: string; signal?: AbortSignal } = {},
): Promise<RunnerRunOutcome> {
  const from = opts.from ?? record.cwd
  if (record.failures.length === 0) {
    return {
      state: 'unavailable',
      reason: `run ${record.id} has no parsed failing nodes (${record.framework})`,
      remedy: 'run the full profile again — rerun-failed needs parseable failures (node-test/cargo)',
    }
  }
  const { profiles } = discoverRunnerProfiles(from)
  const profile = profiles.find(p => p.runner === record.framework && p.kind === 'test')
  if (!profile) {
    return { state: 'stale-profile', reason: `no ${record.framework} test profile in the current discovery`, profiles }
  }
  // Per-runner failure re-selection (vitest/jest rerun by NAME via
  // their own -t flag — a test name is never a file path).
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const joined = record.failures.map(escape).join('|')
  switch (profile.runner) {
    case 'vitest':
      return runRunnerProfile(profile, {
        from,
        argvOverride: [...profile.command, '-t', joined],
        selectionLabel: 'rerun-failed',
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    case 'jest':
      return runRunnerProfile(profile, {
        from,
        argvOverride: [...profile.command, '-t', joined],
        selectionLabel: 'rerun-failed',
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    default:
      return runRunnerProfile(profile, {
        from,
        selection:
          profile.runner === 'node-test' || profile.runner === 'go'
            ? joined
            : record.failures[0]!, // cargo: a substring filter — one node per rerun
        selectionLabel: 'rerun-failed',
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
  }
}

// ── debug one node-test (the SAME js-debug machinery, no scratch program) ───

export interface NodeTestDebugShim {
  framework: 'node-test'
  /** The test FILE — node runs it directly (node:test executes on import). */
  program: string
  /** node's own flags: the anchored --test-name-pattern isolating ONE test. */
  runtimeArgs: string[]
  cwd: string
  note: string
}

/**
 * The node-test sibling of pythonTests.buildDebugTestShim — but node needs
 * NO scratch shim program: a node:test file RUNS its tests when executed
 * directly, and --test-name-pattern is a runtime flag that filters a direct
 * run too (verified live). The node spells `file::name` (self-sufficient,
 * the pytest grammar) or a bare test name resolved against the LATEST
 * node-test run's typed case rows; a name the record cannot place refuses
 * with the remedy. Breakpoints bind in the real files (js-debug maps by
 * path); the launch rides adapterKey 'js' whose resolver ladder owns the
 * js-debug availability truth.
 */
export function buildNodeTestDebugShim(
  nodeId: string,
  opts?: { from?: string },
): NodeTestDebugShim | { state: 'unavailable'; reason: string; remedy: string } {
  const from = opts?.from ?? getCwd()
  const root = findRunnerRoot(from) ?? path.resolve(from)
  const sep = nodeId.indexOf('::')
  let file: string | null = null
  let name: string
  if (sep !== -1) {
    file = nodeId.slice(0, sep)
    name = nodeId.slice(sep + 2)
  } else {
    name = nodeId
    const latest = latestRun(from)
    if (latest && latest.framework === 'node-test') {
      const hit = latest.cases.find(c => c.id === name && typeof c.file === 'string')
      if (hit?.file !== undefined) file = hit.file
    }
  }
  if (name.length === 0) {
    return { state: 'unavailable', reason: `node '${nodeId}' names no test`, remedy: 'spell the node as file::name (or a bare name from the latest node-test run)' }
  }
  if (file === null) {
    return {
      state: 'unavailable',
      reason: `no file for test '${name}' — the latest run's case rows do not place it`,
      remedy: 'spell the node as file::name, or op:"run" first so the failing case rows carry files',
    }
  }
  const program = path.isAbsolute(file) ? file : path.resolve(root, file)
  if (!existsSync(program)) {
    return { state: 'unavailable', reason: `test file not found: ${program}`, remedy: 'spell the node as file::name with a real file' }
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return {
    framework: 'node-test',
    program,
    runtimeArgs: [`--test-name-pattern=^${escaped}$`],
    cwd: root,
    note: `debug shim for '${name}' (node-test) — node runs ${path.basename(program)} directly under js-debug with the anchored name filter; breakpoints bind in the real files`,
  }
}
