import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { latestRun } from './pythonTests.js'
import { discoverRunnerProfiles, findRunnerRoot, resolveRunnerBinary } from './projectRunners.js'

export type DebugPlanRefusal = { state: 'unavailable'; reason: string; remedy: string }

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
    return { state: 'unavailable', reason: "'dlv' not on PATH — Go tests debug through delve's DAP server", remedy: DLV_INSTALL_REMEDY }
  }
  const { file: dir, name } = splitNode(nodeId)
  const segments = name.split('/').filter(Boolean)
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
}

export interface NodeRunnerDebugShim {
  framework: 'vitest' | 'jest'
  program: string
  args: string[]
  cwd: string
  stop: TestStop | null
  note: string
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function splitNode(nodeId: string): { file: string | null; name: string } {
  const sep = nodeId.indexOf('::')
  return sep === -1 ? { file: null, name: nodeId } : { file: nodeId.slice(0, sep), name: nodeId.slice(sep + 2) }
}

function fileFromLatestRun(from: string, framework: string, name: string): string | null {
  const latest = latestRun(from)
  if (!latest || latest.framework !== framework) return null
  const hit = latest.cases.find(c => c.id === name && typeof c.file === 'string')
  return hit?.file ?? null
}

function bodyLine(lines: string[], index: number): number {
  for (let i = index; i < Math.min(index + 4, lines.length); i++) {
    const line = lines[i] ?? ''
    if (/\{\s*$/.test(line)) return i + 2
    if (line.includes('{')) return i + 1
  }
  return index + 1
}

export function locateJsTest(file: string, fullName: string): number | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  const words = fullName.trim().split(/\s+/)
  for (let drop = 0; drop < words.length; drop++) {
    const title = escapeRegExp(words.slice(drop).join(' '))
    const call = new RegExp(`(?:^|[^\\w$.])(?:test|it|bench)(?:\\.\\w+)*\\s*\\(\\s*(['"\`])${title}\\1`)
    const index = lines.findIndex(line => call.test(line))
    if (index !== -1) return bodyLine(lines, index)
  }
  for (let drop = 0; drop < words.length; drop++) {
    const title = escapeRegExp(words.slice(drop).join(' '))
    const quoted = new RegExp(`(['"\`])${title}\\1\\s*,`)
    const index = lines.findIndex(line => quoted.test(line))
    if (index !== -1) return bodyLine(lines, index)
  }
  return null
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
  const file = spelled ?? fileFromLatestRun(from, runner, name)
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
  const anchored = `^${escapeRegExp(name)}$`
  const line = locateJsTest(testFile, name)
  const stop = line === null ? null : { file: testFile, line }
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
