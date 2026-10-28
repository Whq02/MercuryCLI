import * as path from 'node:path'
import type { TestCaseResult, TestRunRecord } from './pythonTests.js'

export interface ReporterRead {
  counts: TestRunRecord['counts']
  failures: string[]
  cases: TestCaseResult[]
  casesTruncated: number
}

const REPORTER_CASE_CAP = 200
const MESSAGE_CAP = 300
const ANSI = /\x1b\[[0-9;]*m/g

function relativeTo(root: string, p: string): string {
  if (!path.isAbsolute(p)) return p
  const rel = path.relative(root, p)
  return rel.startsWith('..') ? p : rel
}

function firstLines(text: string): string {
  const clean = text.replace(ANSI, '')
  const stackAt = clean.search(/\n\s+at /)
  const head = stackAt === -1 ? clean : clean.slice(0, stackAt)
  return head.trim().split('\n').map(l => l.trim()).filter(Boolean).join(' · ').slice(0, MESSAGE_CAP)
}

function lineOf(messages: string[], file: string): number | undefined {
  const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${base}:(\\d+):\\d+`)
  for (const m of messages) {
    const hit = re.exec(m.replace(ANSI, ''))
    if (hit) return Number(hit[1])
  }
  return undefined
}

function bounded(rows: TestCaseResult[]): { cases: TestCaseResult[]; casesTruncated: number } {
  return rows.length > REPORTER_CASE_CAP
    ? { cases: rows.slice(0, REPORTER_CASE_CAP), casesTruncated: rows.length - REPORTER_CASE_CAP }
    : { cases: rows, casesTruncated: 0 }
}

interface JsonAssertion {
  fullName?: string
  title?: string
  ancestorTitles?: string[]
  status?: string
  failureMessages?: string[]
  location?: { line?: number; column?: number } | null
  duration?: number | null
}

interface JsonFileResult {
  name?: string
  status?: string
  message?: string
  assertionResults?: JsonAssertion[]
}

interface JsonReport {
  numTotalTests?: number
  numPassedTests?: number
  numFailedTests?: number
  numPendingTests?: number
  numTodoTests?: number
  numRuntimeErrorTestSuites?: number
  testResults?: JsonFileResult[]
}

export function parseJsonReporter(text: string, root: string): ReporterRead | null {
  let report: JsonReport
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    report = parsed as JsonReport
  } catch {
    return null
  }
  if (!Array.isArray(report.testResults) || typeof report.numTotalTests !== 'number') return null
  const rows: TestCaseResult[] = []
  const failures: string[] = []
  let passed = 0
  let failed = 0
  let skipped = 0
  let errored = 0
  for (const file of report.testResults) {
    const fileName = typeof file.name === 'string' ? relativeTo(root, file.name) : undefined
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : []
    let failedHere = 0
    for (const a of assertions) {
      const id = (a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? ''].join(' ')).trim()
      switch (a.status) {
        case 'passed':
          passed++
          break
        case 'failed': {
          failed++
          failedHere++
          failures.push(id)
          const messages = Array.isArray(a.failureMessages) ? a.failureMessages : []
          const line = typeof a.location?.line === 'number' ? a.location.line : fileName ? lineOf(messages, fileName) : undefined
          rows.push({
            id,
            ...(typeof a.title === 'string' && Array.isArray(a.ancestorTitles) ? { nameParts: [...a.ancestorTitles, a.title] } : {}),
            outcome: 'failed',
            ...(fileName ? { file: fileName } : {}),
            ...(line !== undefined ? { line } : {}),
            ...(messages.length ? { message: firstLines(messages.join('\n')) } : {}),
            ...(typeof a.duration === 'number' ? { durationMs: a.duration } : {}),
          })
          break
        }
        case 'pending':
        case 'skipped':
        case 'todo':
        case 'disabled':
          skipped++
          break
        default:
          break
      }
    }
    if (file.status === 'failed' && failedHere === 0) {
      errored++
      const id = fileName ?? '(unnamed file)'
      failures.push(id)
      rows.push({
        id,
        outcome: 'errored',
        ...(fileName ? { file: fileName } : {}),
        ...(file.message ? { message: firstLines(file.message) } : {}),
      })
    }
  }
  return { counts: { passed, failed, skipped, errored }, failures, ...bounded(rows) }
}

interface GoEvent {
  Action?: string
  Package?: string
  ImportPath?: string
  Test?: string
  Output?: string
}

const GO_TEST_ACTIONS = new Set(['start', 'run', 'pause', 'cont', 'pass', 'fail', 'skip', 'output', 'bench', 'build-output', 'build-fail'])
const GO_LOCATION = /^\s*([\w./\\-]+\.go):(\d+):\s*(.*)$/

export function parseGoTestJson(text: string, _root: string): ReporterRead | null {
  const tests = new Map<string, { id: string; outcome: 'passed' | 'failed' | 'skipped' | null; output: string[] }>()
  const packages = new Map<string, { outcome: 'passed' | 'failed' | 'skipped' | null; output: string[]; failedTests: number }>()
  let events = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let ev: GoEvent
    try {
      ev = JSON.parse(trimmed) as GoEvent
    } catch {
      continue
    }
    if (!ev || typeof ev.Action !== 'string' || !GO_TEST_ACTIONS.has(ev.Action)) continue
    events++
    const pkg = ev.Package ?? ev.ImportPath ?? ''
    const packageRow = packages.get(pkg) ?? { outcome: null, output: [], failedTests: 0 }
    packages.set(pkg, packageRow)
    if (typeof ev.Test === 'string' && ev.Test.length > 0) {
      const key = `${pkg}\u0000${ev.Test}`
      const row = tests.get(key) ?? { id: ev.Test, outcome: null, output: [] }
      tests.set(key, row)
      if (ev.Action === 'output' && typeof ev.Output === 'string' && row.output.length < 60) row.output.push(ev.Output.replace(/\n$/, ''))
      if (ev.Action === 'pass') row.outcome = 'passed'
      if (ev.Action === 'skip') row.outcome = 'skipped'
      if (ev.Action === 'fail') {
        row.outcome = 'failed'
        packageRow.failedTests++
      }
      continue
    }
    if ((ev.Action === 'output' || ev.Action === 'build-output') && typeof ev.Output === 'string' && packageRow.output.length < 60) {
      packageRow.output.push(ev.Output.replace(/\n$/, ''))
    }
    if (ev.Action === 'pass') packageRow.outcome = 'passed'
    if (ev.Action === 'skip') packageRow.outcome = 'skipped'
    if (ev.Action === 'fail' || ev.Action === 'build-fail') packageRow.outcome = 'failed'
  }
  if (events === 0) return null
  const rows: TestCaseResult[] = []
  const failures: string[] = []
  let passed = 0
  let failed = 0
  let skipped = 0
  let errored = 0
  for (const row of tests.values()) {
    if (row.outcome === 'passed') passed++
    else if (row.outcome === 'skipped') skipped++
    else if (row.outcome === 'failed') {
      failed++
      failures.push(row.id)
      const located = row.output.map(l => GO_LOCATION.exec(l)).find((m): m is RegExpExecArray => m !== null)
      const message = row.output.flatMap(l => l.split('\n')).map(l => (GO_LOCATION.exec(l)?.[3] ?? l).trim()).filter(l => l && !/^(=== |--- )/.test(l)).join(' · ')
      rows.push({
        id: row.id,
        outcome: 'failed',
        ...(located ? { file: located[1]!, line: Number(located[2]) } : {}),
        ...(message ? { message: message.slice(0, MESSAGE_CAP) } : {}),
      })
    }
  }
  for (const [pkg, row] of packages) {
    if (row.outcome !== 'failed' || row.failedTests > 0) continue
    errored++
    const id = pkg || '(package)'
    failures.push(id)
    const located = row.output.map(l => GO_LOCATION.exec(l)).find((m): m is RegExpExecArray => m !== null)
    const message = row.output.map(l => l.trim()).filter(l => l && !/^(FAIL|ok)\b/.test(l)).join(' · ')
    rows.push({
      id,
      outcome: 'errored',
      ...(located ? { file: located[1]!, line: Number(located[2]) } : {}),
      ...(message ? { message: message.slice(0, MESSAGE_CAP) } : {}),
    })
  }
  return { counts: { passed, failed, skipped, errored }, failures, ...bounded(rows) }
}

export function goRunPattern(failures: string[]): string {
  const tops = [...new Set(failures.map(f => /^[^/]+/.exec(f)?.[0] ?? '').filter(Boolean))]
  return `^(${tops.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`
}

export function jsTestNamePattern(runner: 'vitest' | 'jest', name: string, parts?: string[]): string {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = parts?.length ? parts.map(escape).join(runner === 'vitest' ? '(?: > | )' : ' ') : escape(name)
  return `^${body}$`
}
