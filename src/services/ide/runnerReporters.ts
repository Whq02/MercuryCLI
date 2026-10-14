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
