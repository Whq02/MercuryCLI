import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { settleChildRun } from '../../utils/childSettle.js'
import { getCwd } from '../../utils/cwd.js'
import { escapeRegExp } from '../../utils/stringUtils.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { lldbDapInstallHint, probeGdbDap, resolveLldbDap } from '../dap/dapClient.js'
import { latestRunAtRoot } from './pythonTests.js'
import { loadTs, parseSource, resolveStructureTypescript } from '../structure/tsFacility.js'
import { jsTestNamePattern } from './runnerReporters.js'
import { discoverRunnerProfiles, findRunnerRoot, resolveRunnerBinary } from './projectRunners.js'

export type DebugPlanRefusal = { state: 'unavailable'; reason: string; remedy: string; debuggerMissing?: string }

export interface CargoTestDebugPlan {
  framework: 'cargo'
  adapterKey: 'lldb' | 'gdb'
  program: string
  args: string[]
  cwd: string
  stop: TestStop | null
  note: string
}

const CARGO_BUILD_TIMEOUT_MS = 300_000
const CARGO_LIST_TIMEOUT_MS = 30_000
const RUST_WALK_CAP = 400
const RUST_SKIP_DIRS = new Set(['target', 'node_modules', '.git'])

async function capture(bin: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string; ended: string | null }> {
  const child = spawn(bin, args, { windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...subprocessEnv(), NO_COLOR: '1' } })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
  const settlement = await settleChildRun(child, { timeoutMs, ...(signal ? { signal } : {}) })
  const ended = settlement.spawnError ? settlement.spawnError : settlement.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : settlement.aborted ? 'interrupted' : null
  return { code: settlement.code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), ended }
}

function rustSourceFiles(dir: string, depth: number, out: string[]): void {
  if (out.length >= RUST_WALK_CAP) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= RUST_WALK_CAP) return
    if (entry.isFile() && entry.name.endsWith('.rs')) out.push(path.join(dir, entry.name))
    else if (entry.isDirectory() && depth > 0 && !entry.name.startsWith('.') && !RUST_SKIP_DIRS.has(entry.name)) rustSourceFiles(path.join(dir, entry.name), depth - 1, out)
  }
}

export function locateRustTest(root: string, testPath: string): Array<{ file: string; line: number }> {
  const fnName = testPath.split('::').pop() ?? testPath
  const decl = new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn ${escapeRegExp(fnName)}\\s*[(<]`)
  const files: string[] = []
  rustSourceFiles(root, 6, files)
  const hits: Array<{ file: string; line: number }> = []
  for (const file of files) {
    let lines: string[]
    try {
      lines = readFileSync(file, 'utf8').split('\n')
    } catch {
      continue
    }
    for (let i = 0; i < lines.length; i++) {
      if (!decl.test(lines[i]!)) continue
      const above = lines.slice(Math.max(0, i - 4), i).join('\n')
      if (/#\[[\w:]*test[^\]]*\]/.test(above)) hits.push({ file, line: i + 1 })
    }
  }
  return hits
}

export async function buildCargoTestDebugPlan(nodeId: string, opts?: { from?: string; signal?: AbortSignal }): Promise<CargoTestDebugPlan | DebugPlanRefusal> {
  const from = opts?.from ?? getCwd()
  const root = findRunnerRoot(from) ?? path.resolve(from)
  const cargo = resolveRunnerBinary('cargo')
  if (cargo === null) {
    return { state: 'unavailable', reason: "'cargo' not on PATH — Rust tests build through cargo", remedy: 'install the Rust toolchain (rustup)' }
  }
  const lldb = resolveLldbDap()
  const adapterKey: 'lldb' | 'gdb' | null = lldb !== null ? 'lldb' : probeGdbDap().viable ? 'gdb' : null
  if (adapterKey === null) {
    return { state: 'unavailable', reason: 'no native debug adapter — neither lldb-dap nor gdb 14+ is reachable', remedy: lldbDapInstallHint(), debuggerMissing: 'native debugger (lldb-dap or gdb 14+)' }
  }
  const name = nodeId.trim()
  if (name.length === 0 || /\s/.test(name)) {
    return { state: 'unavailable', reason: `node '${nodeId}' is not a cargo test path`, remedy: 'spell the node as cargo lists it (module::path::test_name) — op:"run" records the failing names' }
  }
  const build = await capture(cargo, ['test', '--no-run', '--message-format=json'], root, CARGO_BUILD_TIMEOUT_MS, opts?.signal)
  if (build.ended !== null || build.code !== 0) {
    const tail = build.stderr.trim().split('\n').slice(-6).join('\n')
    return { state: 'unavailable', reason: `cargo test --no-run ${build.ended ?? `exited ${build.code ?? 'null'}`}${tail ? `:\n${tail}` : ''}`, remedy: 'fix the build (cargo test --no-run), then debug again' }
  }
  const binaries: Array<{ executable: string; target: string }> = []
  for (const line of build.stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const row = JSON.parse(line) as { reason?: string; executable?: string | null; profile?: { test?: boolean }; target?: { name?: string } }
      if (row.reason === 'compiler-artifact' && row.profile?.test === true && typeof row.executable === 'string' && row.executable.length > 0) {
        binaries.push({ executable: row.executable, target: row.target?.name ?? path.basename(row.executable) })
      }
    } catch {
      continue
    }
  }
  if (binaries.length === 0) {
    return { state: 'unavailable', reason: 'cargo test --no-run built no test binary', remedy: 'add a #[test] to the crate, or check the cargo output' }
  }
  let selected: { executable: string; target: string } | null = null
  for (const binary of binaries) {
    const listing = await capture(binary.executable, ['--list', '--format', 'terse'], root, CARGO_LIST_TIMEOUT_MS, opts?.signal)
    if (listing.stdout.split('\n').some(l => l.trim() === `${name}: test`)) {
      selected = binary
      break
    }
  }
  if (selected === null) {
    return {
      state: 'unavailable',
      reason: `no test named '${name}' in the ${binaries.length} test binar${binaries.length === 1 ? 'y' : 'ies'} cargo built (${binaries.map(b => b.target).join(', ')})`,
      remedy: 'spell the node as cargo lists it (module::path::test_name) — op:"run" records the failing names',
    }
  }
  const hits = locateRustTest(root, name)
  const stop = hits[0] ?? null
  const relative = (p: string): string => path.relative(root, p)
  return {
    framework: 'cargo',
    adapterKey,
    program: selected.executable,
    args: ['--exact', name, '--nocapture', '--test-threads=1'],
    cwd: root,
    stop,
    note:
      stop === null
        ? `the fn of '${name}' was not found under ${root} — the session stops at the test binary's entry; set a breakpoint with the Debug tool, then continue`
        : `${adapterKey === 'lldb' ? 'lldb-dap' : 'gdb'} runs the ${selected.target} test binary for '${name}' alone and stops on its first line (${relative(stop.file)}:${stop.line})${hits.length > 1 ? ` — ${hits.length} declarations carry that name; the first is used` : ''}`,
  }
}

export const DLV_INSTALL_REMEDY = 'install delve: go install github.com/go-delve/delve/cmd/dlv@latest'

export interface GoTestDebugPlan {
  framework: 'go'
  program: string
  args: string[]
  cwd: string
  launchExtras: { mode: 'test' }
  stop: TestStop
  note: string
}

const GO_WALK_CAP = 400
const GO_SKIP_DIRS = new Set(['vendor', 'node_modules', 'testdata', '.git'])

function goTestFiles(dir: string, depth: number, out: string[]): void {
  if (out.length >= GO_WALK_CAP) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= GO_WALK_CAP) return
    if (entry.isFile() && entry.name.endsWith('_test.go')) out.push(path.join(dir, entry.name))
    else if (entry.isDirectory() && depth > 0 && !entry.name.startsWith('.') && !GO_SKIP_DIRS.has(entry.name)) goTestFiles(path.join(dir, entry.name), depth - 1, out)
  }
}

export function locateGoTest(root: string, dir: string | null, topLevel: string): Array<{ file: string; line: number }> {
  const files: string[] = []
  goTestFiles(dir === null ? root : path.resolve(root, dir), dir === null ? 4 : 0, files)
  const decl = new RegExp(`^func ${escapeRegExp(topLevel)}\\s*\\(`)
  const hits: Array<{ file: string; line: number }> = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const index = text.split('\n').findIndex(line => decl.test(line))
    if (index !== -1) hits.push({ file, line: index + 1 })
  }
  return hits
}

export function buildGoTestDebugPlan(nodeId: string, opts?: { from?: string }): GoTestDebugPlan | DebugPlanRefusal {
  const from = opts?.from ?? getCwd()
  const root = findRunnerRoot(from) ?? path.resolve(from)
  if (resolveRunnerBinary('go') === null) {
    return { state: 'unavailable', reason: "'go' not on PATH — Go tests build and run through the Go toolchain", remedy: `install the Go toolchain, then ${DLV_INSTALL_REMEDY}` }
  }
  if (resolveRunnerBinary('dlv') === null) {
    return { state: 'unavailable', reason: "'dlv' not on PATH — Go tests debug through delve's DAP server", remedy: DLV_INSTALL_REMEDY, debuggerMissing: 'Go debugger (dlv)' }
  }
  const { file: dir, name } = splitNode(nodeId)
  const segments = name.match(/[^/]+/g) ?? []
  const topLevel = segments[0] ?? ''
  if (!/^Test\w*$/.test(topLevel)) {
    return { state: 'unavailable', reason: `node '${nodeId}' is not a Go test name`, remedy: 'spell the node as TestName, TestName/subtest, or dir::TestName (a go test -json run lists them)' }
  }
  const hits = locateGoTest(root, dir, topLevel)
  if (hits.length === 0) {
    return {
      state: 'unavailable',
      reason: `no func ${topLevel} in any *_test.go under ${dir === null ? root : path.resolve(root, dir)}`,
      remedy: 'spell the node as dir::TestName with the package directory, or op:"run" first to list the tests',
    }
  }
  if (hits.length > 1) {
    return {
      state: 'unavailable',
      reason: `func ${topLevel} is declared in ${hits.length} packages: ${hits.map(h => path.relative(root, path.dirname(h.file)) || '.').join(', ')}`,
      remedy: 'spell the node as dir::TestName to pick the package',
    }
  }
  const hit = hits[0]!
  const pkgDir = path.dirname(hit.file)
  const pattern = segments.map(s => `^${escapeRegExp(s)}$`).join('/')
  return {
    framework: 'go',
    program: pkgDir,
    args: ['-test.run', pattern, '-test.v'],
    cwd: root,
    launchExtras: { mode: 'test' },
    stop: { file: hit.file, line: hit.line },
    note: `dlv builds the test binary for ${path.relative(root, pkgDir) || '.'} and stops on the first line of ${name} (${path.relative(root, hit.file)}:${hit.line})`,
  }
}

export interface TestStop {
  file: string
  line: number
  column?: number
}

export interface NodeRunnerDebugShim {
  framework: 'vitest' | 'jest'
  program: string
  args: string[]
  cwd: string
  stop: TestStop | null
  note: string
}

function splitNode(nodeId: string): { file: string | null; name: string } {
  const sep = nodeId.indexOf('::')
  return sep === -1 ? { file: null, name: nodeId } : { file: nodeId.slice(0, sep), name: nodeId.slice(sep + 2) }
}

function fileFromLatestRun(root: string, framework: string, name: string): string | null {
  const latest = latestRunAtRoot(root)
  if (!latest || latest.framework !== framework) return null
  const hit = latest.cases.find(c => c.id === name && typeof c.file === 'string')
  return hit?.file ?? null
}

function sourceJsTest(file: string, name: string): { nameParts: string[]; line: number; column?: number } | null {
  const resolution = resolveStructureTypescript(path.dirname(file))
  if (resolution.state !== 'ok') return null
  const ts = loadTs(resolution.modulePath)
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const { sourceFile, parseErrors } = parseSource(ts, file, text)
  if (parseErrors.length) return null
  const tests: Array<{ nameParts: string[]; line: number; column?: number }> = []
  const walk = (node: import('typescript').Node, parents: string[]): void => {
    if (ts.isCallExpression(node)) {
      let callee = node.expression
      while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) callee = callee.expression
      const kind = ts.isIdentifier(callee) ? callee.text : ''
      const title = node.arguments[0]
      const callback = node.arguments.find(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
      if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const parts = [...parents, title.text]
        if (kind === 'describe' || kind === 'suite') { walk(callback.body, parts); return }
        if (kind === 'it' || kind === 'test' || kind === 'bench') {
          const body = callback.body
          const first = ts.isBlock(body) ? body.statements[0] ?? body : body
          const initializer = ts.isVariableStatement(first) ? first.declarationList.declarations.find(declaration => declaration.initializer)?.initializer : undefined
          const position = sourceFile.getLineAndCharacterOfPosition((initializer ?? first).getStart(sourceFile))
          tests.push({ nameParts: parts, line: position.line + 1, ...(initializer ? { column: position.character + 1 } : {}) })
          return
        }
      }
    }
    ts.forEachChild(node, child => walk(child, parents))
  }
  walk(sourceFile, [])
  const exact = tests.filter(test => test.nameParts.join(' ') === name || test.nameParts.join(' > ') === name)
  const matches = exact.length ? exact : tests.filter(test => test.nameParts.at(-1) === name)
  return matches.length === 1 ? matches[0]! : null
}

export function locateJsTest(file: string, fullName: string): number | null {
  return sourceJsTest(file, fullName)?.line ?? null
}

function runnerEntryScript(root: string, runner: 'vitest' | 'jest'): string | null {
  const packageDir = path.join(root, 'node_modules', runner)
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[runner]
    if (bin) {
      const script = path.join(packageDir, bin)
      if (existsSync(script)) return script
    }
  } catch {
    return existsSync(path.join(root, 'node_modules', '.bin', runner)) ? path.join(root, 'node_modules', '.bin', runner) : null
  }
  const link = path.join(root, 'node_modules', '.bin', runner)
  return existsSync(link) ? link : null
}

export function buildNodeRunnerDebugShim(
  runner: 'vitest' | 'jest',
  nodeId: string,
  opts?: { from?: string },
): NodeRunnerDebugShim | DebugPlanRefusal {
  const from = opts?.from ?? getCwd()
  const root = findRunnerRoot(from) ?? path.resolve(from)
  const profile = discoverRunnerProfiles(from).profiles.find(p => p.runner === runner && p.kind === 'test')
  if (profile && profile.availability.state !== 'ok') {
    return { state: 'unavailable', reason: profile.availability.reason, remedy: profile.availability.remedy }
  }
  const { file: spelled, name } = splitNode(nodeId)
  if (name.length === 0) {
    return { state: 'unavailable', reason: `node '${nodeId}' names no test`, remedy: `spell the node as file::name (or a bare name from the latest ${runner} run)` }
  }
  const file = spelled ?? fileFromLatestRun(root, runner, name)
  if (file === null) {
    return {
      state: 'unavailable',
      reason: `no file for test '${name}' — the latest run's case rows do not place it`,
      remedy: 'spell the node as file::name, or op:"run" first so the failing case rows carry files',
    }
  }
  const testFile = path.isAbsolute(file) ? file : path.resolve(root, file)
  if (!existsSync(testFile)) {
    return { state: 'unavailable', reason: `test file not found: ${testFile}`, remedy: 'spell the node as file::name with a real file' }
  }
  const program = runnerEntryScript(root, runner)
  if (program === null) {
    return {
      state: 'unavailable',
      reason: `${runner} is declared but node_modules/${runner} is missing`,
      remedy: 'install the project dependencies with the declared package manager',
    }
  }
  const latest = latestRunAtRoot(root)
  const recorded = latest?.framework === runner ? latest.cases.filter(c => c.file && path.resolve(root, c.file) === testFile && (c.id === name || c.nameParts?.at(-1) === name)) : []
  const hit = recorded.length === 1 ? recorded[0] : undefined
  const source = sourceJsTest(testFile, hit?.id ?? name)
  const anchored = jsTestNamePattern(runner, hit?.id ?? name, hit?.nameParts ?? source?.nameParts)
  const line = source?.line ?? null
  const stop = line === null ? null : { file: testFile, line, ...(source?.column !== undefined ? { column: source.column } : {}) }
  const relativeFile = path.relative(root, testFile)
  const args =
    runner === 'vitest'
      ? ['run', relativeFile, '-t', anchored, '--no-file-parallelism', '--test-timeout=0']
      : ['--runInBand', relativeFile, '-t', anchored]
  return {
    framework: runner,
    program,
    args,
    cwd: root,
    stop,
    note:
      stop === null
        ? `the line of '${name}' was not found in ${relativeFile} — the session stops at ${runner}'s entry; set a breakpoint with the Debug tool (op:"breakpoints"), then continue`
        : `the session stops on the first line of '${name}' (${relativeFile}:${stop.line}); ${runner} runs that file alone under js-debug`,
  }
}
