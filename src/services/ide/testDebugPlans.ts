import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { latestRun } from './pythonTests.js'
import { discoverRunnerProfiles, findRunnerRoot } from './projectRunners.js'

export type DebugPlanRefusal = { state: 'unavailable'; reason: string; remedy: string }

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
