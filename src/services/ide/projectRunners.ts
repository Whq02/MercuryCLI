import { spawn } from 'node:child_process'
import { settleChildRun } from '../../utils/childSettle.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { storeArtifact } from '../../utils/artifacts/store.js'
import {
  latestRunAtRoot,
  persistTestRun,
  pythonTestsEnabled,
  type RunnerFramework,
  type TestCaseResult,
  type TestRunRecord,
} from './pythonTests.js'
import { findPythonTestFiles } from './pythonProject.js'
import { goRunPattern, jsTestNamePattern, parseGoTestJson, parseJsonReporter, type ReporterRead } from './runnerReporters.js'

export type RunnerKind = 'test' | 'check' | 'build'

export interface RunnerProfile {

  id: string
  runner: RunnerFramework
  kind: RunnerKind
  title: string

  source: string
  root: string

  command: string[]

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

export function resolveRunnerBinary(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | null {
  const explicit = path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')
  const paths = explicit ? [path.dirname(bin)] : (env.PATH ?? '').split(path.delimiter)
  const name = explicit ? path.basename(bin) : bin
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const hasExtension = extensions.some(ext => name.toLowerCase().endsWith(ext.toLowerCase()))
  const exts: string[] = platform === 'win32' && !hasExtension ? [] : ['']
  if (platform === 'win32' && !hasExtension) {
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
      const full = path.join(p, name + ext)
      try {
        if (existsSync(full)) return full
      } catch {
      }
    }
  }
  return null
}

function which(bin: string): string | null {
  return resolveRunnerBinary(bin)
}

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

export function detectPackageManager(root: string): { bin: string } | { missing: string } {
  if (existsSync(path.join(root, 'bun.lock')) || existsSync(path.join(root, 'bun.lockb'))) return { bin: 'bun' }
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return { bin: 'pnpm' }
  if (existsSync(path.join(root, 'yarn.lock'))) return { bin: 'yarn' }
  if (existsSync(path.join(root, 'package-lock.json'))) return { bin: 'npm' }
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { packageManager?: string }
    const pm = pkg.packageManager?.split('@')[0]
    if (pm === 'bun' || pm === 'npm' || pm === 'pnpm' || pm === 'yarn') return { bin: pm }
  } catch {
  }
  return { missing: 'no lockfile and no packageManager field — declare one; Mercury never guesses a package manager' }
}

function binaryAvailability(bin: string, remedy: string): RunnerProfile['availability'] {
  return which(bin) ? { state: 'ok' } : { state: 'unavailable', reason: `'${bin}' not on PATH`, remedy }
}

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
    const resolved = resolveRunnerBinary(bin)
    profiles.push({
      id: profileId([pkgPath, 'vitest', 'test']),
      runner: 'vitest',
      kind: 'test',
      title: 'vitest (declared)',
      source: 'package.json',
      root,
      command: [resolved ?? bin, 'run', '--reporter=default', '--reporter=json'],
      selection: 'file',
      availability: resolved !== null
        ? { state: 'ok' }
        : { state: 'unavailable', reason: 'vitest is declared but node_modules/.bin/vitest is missing', remedy: 'install the project dependencies with the declared package manager' },
    })
  } else if (deps.jest !== undefined) {
    const bin = path.join(root, 'node_modules', '.bin', 'jest')
    const resolved = resolveRunnerBinary(bin)
    profiles.push({
      id: profileId([pkgPath, 'jest', 'test']),
      runner: 'jest',
      kind: 'test',
      title: 'jest (declared)',
      source: 'package.json',
      root,
      command: [resolved ?? bin, '--json'],
      selection: 'file',
      availability: resolved !== null
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

      command: ['node', '--test', '--test-reporter', 'tap'],
      selection: 'node-pattern',
      availability: binaryAvailability('node', 'install Node.js ≥ 20'),
    })
  }

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
    mk('test', ['go', 'test', '-json', './...'], 'go test ./...', 'go-pattern'),
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

export interface SubPackage {
  dir: string
  manifests: string[]
  profiles: RunnerProfile[]
}

const RUNNER_MANIFESTS = ['package.json', 'Cargo.toml', 'go.mod'] as const
const SUB_PACKAGE_SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', 'venv', '__pycache__'])
const SUB_PACKAGE_SCAN_CAP = 200

export function discoverSubPackages(root: string): SubPackage[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: SubPackage[] = []
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, SUB_PACKAGE_SCAN_CAP)) {
    if (!e.isDirectory() || e.name.startsWith('.') || SUB_PACKAGE_SKIP.has(e.name)) continue
    const dir = path.join(root, e.name)
    const manifests = RUNNER_MANIFESTS.filter(m => existsSync(path.join(dir, m)))
    if (manifests.length === 0) continue
    out.push({ dir: e.name, manifests, profiles: [...jsProfiles(dir), ...cargoProfiles(dir), ...goProfiles(dir)] })
  }
  return out
}

export function subPackageTestRunners(sub: SubPackage): string[] {
  return [...new Set(sub.profiles.filter(p => p.kind === 'test').map(p => p.runner))]
}

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

const RUNNER_NO_MATCH_WORDS: Record<RunnerFramework, RegExp[]> = {
  jest: [/^Pattern: .* - 0 matches$/m, /^No tests found.*$/m, /^Tests:\s+\d+ skipped, \d+ total$/m],
  vitest: [/^No test files found.*$/m, /^filter: .*$/m, /^\s*Tests\s+\d+ skipped.*$/m],
  'node-test': [/^Could not find .*$/m, /^1\.\.0$/m],
  go: [/testing: warning: no tests to run/, /\[no test files\]/],
  cargo: [/^test result: \w+\. 0 passed; 0 failed;.*$/m, /^running 0 tests$/m],
}
const NODE_TEST_CASE_ROW = /^\s+(?:not )?ok \d+ - /m

function runnerNoMatchWords(runner: RunnerFramework, out: string): string | undefined {
  const words: string[] = []
  for (const re of RUNNER_NO_MATCH_WORDS[runner]) {
    const m = re.exec(out)
    if (m !== null && !words.includes(m[0].trim())) words.push(m[0].trim())
  }
  return words.length === 0 ? undefined : words.slice(0, 2).join(' · ')
}

export function reporterFileFlag(runner: RunnerFramework): string | null {
  switch (runner) {
    case 'vitest':
    case 'jest':
      return '--outputFile='
    default:
      return null
  }
}

function readReporter(profile: RunnerProfile, reporterFile: string | null, combined: string): ReporterRead | null {
  if (profile.kind !== 'test') return null
  if (reporterFile !== null) {
    let text: string
    try {
      text = readFileSync(reporterFile, 'utf8')
    } catch {
      return null
    }
    return parseJsonReporter(text, profile.root)
  }
  if (profile.runner === 'go') return parseGoTestJson(combined, profile.root)
  return null
}

const CASE_PARSE_CAP = 50

function relIfUnder(root: string, p: string): string {
  if (!path.isAbsolute(p)) return p
  const rel = path.relative(root, p)
  if (!rel.startsWith('..')) return rel

  try {
    const realRel = path.relative(require('node:fs').realpathSync(root), p)
    if (!realRel.startsWith('..')) return realRel
  } catch {
  }
  return p
}

function failureMessage(lines: string[]): string {
  return lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean).join(' · ').slice(0, 300)
}
export function parseRunnerCases(runner: RunnerFramework, out: string, root: string): TestCaseResult[] {
  const cases: TestCaseResult[] = []
  const push = (c: TestCaseResult): void => {
    if (cases.length < CASE_PARSE_CAP) cases.push(c)
  }
  switch (runner) {
    case 'node-test': {
      const lines = out.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*not ok \d+ - (.+?)(?: #.*)?$/.exec(lines[i]!)
        if (!m) continue
        const row: TestCaseResult = { id: m[1]!.trim(), outcome: 'failed' }
        const fields = new Map<string, string[]>()
        let indent: number | undefined
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j]!
          if (/^\s*(?:(?:not )?ok \d+ |\.\.\.)/.test(line)) break
          const start = /^(\s*)---\s*$/.exec(line)
          if (start) indent = start[1]!.length
          const loc = /location:\s*'([^']+):(\d+):\d+'/.exec(line)
          if (loc) {
            row.file = relIfUnder(root, loc[1]!)
            row.line = Number(loc[2])
          }
          const field = /^(\s+)(error|actual|expected|diff):\s*(.*)$/.exec(line)
          if (!field || (indent !== undefined && field[1]!.length !== indent)) continue
          const value = field[3]!
          const parts: string[] = []
          if (value && !/^[|>][+-]?$/.test(value)) {
            parts.push(value.replace(/^(['"])(.*)\1$/, '$2'))
          } else {
            let size = 0
            while (j + 1 < lines.length) {
              const next = lines[j + 1]!
              if (next.trim() && next.search(/\S/) <= field[1]!.length) break
              j++
              if (size < 300 && next.trim()) {
                const part = next.trim().slice(0, 300 - size)
                parts.push(part)
                size += part.length
              }
            }
          }
          fields.set(field[2]!, parts)
        }
        const error = fields.get('error') ?? []
        const values = ['actual', 'expected'].flatMap(key => fields.has(key) ? [`${key}: ${failureMessage(fields.get(key)!).slice(0, 70)}`] : [])
        const message = failureMessage([error[0]?.slice(0, values.length ? 100 : 300) ?? '', ...values, ...error.slice(1), ...(fields.get('diff') ?? [])])
        if (message) row.message = message
        push(row)
      }
      return cases
    }
    case 'cargo': {

      const sections = out.split(/^---- (\S+) stdout ----$/m)
      for (let i = 1; i + 1 < sections.length; i += 2) {
        const name = sections[i]!
        const body = sections[i + 1]!
        const row: TestCaseResult = { id: name, outcome: 'failed' }
        const modern = /panicked at ([^\s:]+\.rs):(\d+):\d+:\n?([^]*?)(?=\n(?:note:|stack backtrace:|failures:|test result:)|$)/.exec(body)
        const legacy = /panicked at '([^']*)',\s*([^\s:]+\.rs):(\d+):\d+/.exec(body)
        if (modern) {
          row.file = relIfUnder(root, modern[1]!)
          row.line = Number(modern[2])
          if (modern[3]?.trim()) row.message = failureMessage(modern[3]!.split('\n'))
        } else if (legacy) {
          row.message = failureMessage(legacy[1]!.split('\n'))
          row.file = relIfUnder(root, legacy[2]!)
          row.line = Number(legacy[3])
        }
        push(row)
      }
      return cases
    }
    case 'go': {

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
            const detail = [loc[3]!]
            while (j + 1 < lines.length && /^\s+\S/.test(lines[j + 1]!) && !/^\s*--- /.test(lines[j + 1]!)) detail.push(lines[++j]!)
            const message = failureMessage(detail)
            if (message) row.message = message
            break
          }
        }
        push(row)
      }
      return cases
    }
    case 'vitest': {

      const lines = out.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:×|✕|FAIL)\s+(\S+\.[cm]?[jt]sx?) > (.+)$/.exec(lines[i]!.replace(/\x1b\[[0-9;]*m/g, ''))
        if (!m) continue
        const detail: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j]!
          if (/^\s*(?:FAIL |❯ |at |Test Files |Tests |[─━]{3})/.test(line)) break
          detail.push(line)
        }
        const message = failureMessage(detail)
        push({ id: m[2]!.trim(), outcome: 'failed', file: relIfUnder(root, m[1]!), ...(message ? { message } : {}) })
      }
      return cases
    }
    case 'jest': {

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
        const detail: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j]!
          if (/^\s*(?:● |Test Suites:|Tests:)/.test(line)) break
          const loc = /at .*\(([^)]+?\.[cm]?[jt]sx?):(\d+):\d+\)/.exec(line)
          if (loc) {
            row.file = relIfUnder(root, loc[1]!)
            row.line = Number(loc[2])
            break
          }
          detail.push(line)
        }
        const message = failureMessage(detail)
        if (message) row.message = message
        push(row)
      }
      return cases
    }
    default:
      return cases
  }
}

export type ChangedSelection =
  | { state: 'ok'; argv: string[]; label: string; changedCount: number }
  | { state: 'unavailable'; reason: string; remedy: string }

export function changedRunnerSelection(profile: RunnerProfile): ChangedSelection {
  let changed: string[]
  try {
    const { gitStatus } = require('../gitGraph/observe.js') as typeof import('../gitGraph/observe.js')
    const s = gitStatus(profile.root)
    if ('state' in s) {
      return { state: 'unavailable', reason: s.note, remedy: 'changed-file selection needs a git repository' }
    }

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
        argv: ['go', 'test', '-json', ...pkgs.slice(0, 20).map(p => (p === '.' ? '.' : `./${p}`))],
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

  selection?: string
  selectionKind?: 'node' | 'path'
  selectionLabel?: string

  argvOverride?: string[]

  onOutput?: (view: { tail: string; lines: number }, elapsedMs: number) => void
  signal?: AbortSignal

  timeoutMs?: number

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

    argv = [...opts.argvOverride]
    selectionLabel = opts.selectionLabel ?? 'changed'
  } else if (opts.selection) {
    switch (profile.selection) {
      case 'node-pattern':
        if (opts.selectionKind === 'path') argv.push(opts.selection)
        else argv.push('--test-name-pattern', opts.selection)
        break
      case 'file':
        argv.push(opts.selection)
        break
      case 'cargo-filter':
      case 'go-pattern':
        if (opts.selectionKind === 'path') {
          return {
            state: 'unavailable',
            reason: `profile '${profile.title}' selects tests by name, not by file`,
            remedy: 'pass node (a test name from discover) instead of path, or run the profile whole',
          }
        }
        if (profile.selection === 'cargo-filter') argv.push(opts.selection)
        else argv.splice(argv.length - 1, 0, '-run', opts.selection)
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

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(argv[0]!) && (profile.runner === 'vitest' || profile.runner === 'jest')) {
    const entry = path.join(profile.root, 'node_modules', profile.runner, profile.runner === 'vitest' ? 'vitest.mjs' : 'bin/jest.js')
    if (!existsSync(entry)) {
      return { state: 'unavailable', reason: `${profile.runner}'s JavaScript entry is missing: ${entry}`, remedy: 'install the project dependencies with the declared package manager' }
    }
    argv = [process.execPath, entry, ...argv.slice(1)]
  }

  const reporterDir = profile.kind === 'test' && reporterFileFlag(profile.runner) !== null ? mkdtempSync(path.join(tmpdir(), 'mercury-runner-report-')) : null
  const reporterFile = reporterDir !== null ? path.join(reporterDir, 'report.json') : null
  if (reporterFile !== null) argv.push(`${reporterFileFlag(profile.runner)}${reporterFile}`)

  const startedAt = Date.now()
  const id = `run-${startedAt}-rp${++runSeq}`
  const bin = argv[0]!

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

      opts.onOutput?.(
        { tail: chunk.subarray(Math.max(0, chunk.length - 2048)).toString('utf8'), lines: lineCount },
        Date.now() - startedAt,
      )
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

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
  const reporter = readReporter(profile, reporterFile, combined)
  if (reporterDir !== null) rmSync(reporterDir, { recursive: true, force: true })
  const parsed: { counts: TestRunRecord['counts'] | null; failures: string[] } =
    reporter ??
    (profile.runner === 'node-test'
      ? parseNodeTestTap(combined)
      : profile.runner === 'cargo'
        ? parseCargoTest(combined)
        : { counts: null, failures: [] as string[] })

  const exitOk = result.code === 0 && !result.errMsg
  const failedByCounts = parsed.counts !== null && parsed.counts.failed > 0
  const ranCount = parsed.counts === null ? null : parsed.counts.passed + parsed.counts.failed + parsed.counts.errored
  const noMatchWords = profile.kind === 'test' ? runnerNoMatchWords(profile.runner, combined) : undefined
  const noCaseRan = profile.runner === 'node-test' ? parsed.counts !== null && /^1\.\.0$/m.test(combined) && !NODE_TEST_CASE_ROW.test(combined) : ranCount === 0
  const noMatch = profile.kind === 'test' && !result.errMsg && (noCaseRan || (ranCount === null && noMatchWords !== undefined))
  const noMatchReason = `${selectionLabel === 'all' ? 'no test ran' : `no test matched ${selectionLabel}`} — ${noMatchWords ?? `${profile.runner} reported no test case`}${selectionLabel === 'rerun-failed' ? '; run the full profile to refresh its case names' : ''}`
  const verdictNotes: string[] = noMatch ? [noMatchReason] : []
  if (parsed.counts === null && profile.kind === 'test' && !noMatch) {
    verdictNotes.push(`counts not parsed for ${profile.runner} — exit state is the only verdict`)
  }
  if (result.errMsg) verdictNotes.push(`runner did not exit cleanly: ${result.errMsg}`)
  if (exitOk && failedByCounts) verdictNotes.push('exit code 0 disagreed with parsed failures — treated as FAILED')
  if (reporter !== null && !exitOk && !result.errMsg && !noMatch && reporter.counts.failed === 0 && reporter.counts.errored === 0) {
    verdictNotes.push(`${profile.runner} exited ${result.code ?? 'null'} with no failing case in its report — read the output`)
  }

  const runFailed = result.code !== 0 || Boolean(result.errMsg)
  const cases = noMatch ? [] : reporter !== null ? reporter.cases : runFailed ? parseRunnerCases(profile.runner, combined, profile.root) : []

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
    }
  }

  let diagnosticsNote: string | undefined
  try {
    const { getPendingLSPDiagnosticCount } =
      require('../lsp/LSPDiagnosticRegistry.js') as typeof import('../lsp/LSPDiagnosticRegistry.js')
    diagnosticsNote = `${getPendingLSPDiagnosticCount()} pending LSP diagnostic(s)`
  } catch {
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
    counts: noMatch
      ? { passed: 0, failed: 0, skipped: parsed.counts?.skipped ?? 0, errored: 0 }
      : (parsed.counts ?? { passed: 0, failed: exitOk ? 0 : 1, skipped: 0, errored: result.errMsg ? 1 : 0 }),
    cases,
    ...(reporter !== null && reporter.casesTruncated > 0 ? { casesTruncated: reporter.casesTruncated } : {}),
    failures: noMatch ? [] : parsed.failures.length > 0 ? parsed.failures : runFailed ? cases.map(c => c.id) : [],
    ...(outputArtifactRef ? { outputArtifactRef } : {}),
    outputTail: outputLines.slice(-OUTPUT_TAIL_LINES),
    exitCode: result.code,
    ...(noMatch ? { verdict: 'no-match' as const } : {}),
    ...(verdictNotes.length > 0 ? { verdictNote: verdictNotes.join(' · ') } : {}),
    ...(diagnosticsNote ? { diagnosticsNote } : {}),
  }
  await persistTestRun(profile.root, record)
  return { state: 'ok', record }
}

export type TestLane =
  | { lane: 'python'; framework?: 'pytest' | 'unittest' }
  | { lane: 'runner'; profile: RunnerProfile }
  | { lane: 'runner-missing'; runner: string; below?: SubPackage[] }
  | { lane: 'ambiguous'; options: string[] }
  | { lane: 'sub-packages'; root: string; packages: SubPackage[]; runner?: string }

export function hasPythonSignal(from: string = getCwd(), skipDirs: ReadonlySet<string> = new Set()): boolean {
  const root = findRunnerRoot(from) ?? path.resolve(from)
  for (const f of ['pyproject.toml', 'setup.py', 'setup.cfg', 'conftest.py']) {
    if (existsSync(path.join(root, f))) return true
  }
  return findPythonTestFiles(root, skipDirs).length > 0
}

export function hasPythonTestFiles(root: string): boolean {
  return findPythonTestFiles(root).length > 0
}

export function resolveTestLane(from: string = getCwd(), explicit?: string): TestLane {
  if (explicit === 'pytest' || explicit === 'unittest') {
    return { lane: 'python', framework: explicit }
  }
  const { root, profiles } = discoverRunnerProfiles(from)
  const testProfiles = profiles.filter(p => p.kind === 'test')
  const below = root === null && pythonTestsEnabled() ? discoverSubPackages(path.resolve(from)) : []
  if (explicit) {
    const match = testProfiles.find(p => p.runner === explicit)
    if (match) return { lane: 'runner', profile: match }
    const declaring = below.filter(s => subPackageTestRunners(s).includes(explicit as RunnerFramework))
    if (declaring.length === 1) return { lane: 'runner', profile: declaring[0]!.profiles.find(p => p.kind === 'test' && p.runner === explicit)! }
    if (declaring.length > 1) return { lane: 'sub-packages', root: path.resolve(from), packages: declaring, runner: explicit }
    return { lane: 'runner-missing', runner: explicit, ...(below.length > 0 ? { below } : {}) }
  }
  if (below.length > 0) {
    if (hasPythonSignal(from, new Set(below.map(s => s.dir)))) return { lane: 'python' }
    const declaring = below.filter(s => subPackageTestRunners(s).length > 0)
    if (declaring.length === 1 && subPackageTestRunners(declaring[0]!).length === 1) {
      return { lane: 'runner', profile: declaring[0]!.profiles.find(p => p.kind === 'test')! }
    }
    return { lane: 'sub-packages', root: path.resolve(from), packages: below }
  }
  if (hasPythonSignal(from)) return { lane: 'python' }
  if (testProfiles.length === 0) return { lane: 'python' }
  const runners = [...new Set(testProfiles.map(p => p.runner))]
  if (runners.length === 1) return { lane: 'runner', profile: testProfiles[0]! }
  return { lane: 'ambiguous', options: runners }
}

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

  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const joined = record.failures.map(name => profile.runner === 'vitest' || profile.runner === 'jest'
    ? jsTestNamePattern(profile.runner, name, record.cases.find(c => c.id === name)?.nameParts)
    : escape(name)).join('|')
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
          profile.runner === 'node-test'
            ? joined
            : profile.runner === 'go'
              ? goRunPattern(record.failures)
              : record.failures[0]!,
        selectionLabel: 'rerun-failed',
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
  }
}

export interface NodeTestDebugShim {
  framework: 'node-test'

  program: string

  runtimeArgs: string[]
  cwd: string
  note: string
}

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
    const latest = latestRunAtRoot(root)
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
