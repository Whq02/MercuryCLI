
import { readFileSync } from 'node:fs'
import type { TestCaseResult, TestRunRecord } from './pythonTests.js'
import { unityTestResultsPath } from './unityProject.js'

const INPUT_CAP_BYTES = 32 * 1024 * 1024
const CASE_CAP = 200
const MESSAGE_CAP = 2_000

export interface UnityTestRunParse {
  state: 'ok'
  result: string
  counts: { passed: number; failed: number; skipped: number; errored: number }
  inconclusive: number
  cases: TestCaseResult[]
  casesTruncated?: number
  failures: string[]
  durationMs?: number
  verdictNote?: string
}

export interface UnityTestRunRejected {
  state: 'rejected'
  reason: string
}

export type UnityTestResultsOutcome = UnityTestRunParse | UnityTestRunRejected

function decodeXmlText(raw: string): string {
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  const text = cdata?.[1] !== undefined ? cdata[1] : raw
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([A-Za-z][\w.-]{0,63})="([^"]*)"/g)) {
    if (m[1] !== undefined && m[2] !== undefined) out[m[1]] = decodeXmlText(m[2])
  }
  return out
}

function toInt(v: string | undefined): number {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

export function parseUnityTestResults(xml: string): UnityTestResultsOutcome {
  if (Buffer.byteLength(xml, 'utf8') > INPUT_CAP_BYTES) {
    return { state: 'rejected', reason: `results file exceeds the ${INPUT_CAP_BYTES / (1024 * 1024)}MiB parser cap` }
  }
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    return {
      state: 'rejected',
      reason: 'DOCTYPE/ENTITY markup refused — this parser performs no entity resolution, ever (Unity results files carry none)',
    }
  }
  const runTag = xml.match(/<test-run\b[^>]*>/)
  if (!runTag) {
    return { state: 'rejected', reason: 'no <test-run> root — not a Unity/NUnit results file' }
  }
  const run = attrs(runTag[0])
  const cases: TestCaseResult[] = []
  const failures: string[] = []
  let total = 0
  let passed = 0
  let failed = 0
  let skipped = 0
  let inconclusive = 0
  const caseRe = /<test-case\b([^>]*?)(\/>|>([\s\S]*?)<\/test-case>)/g
  for (const m of xml.matchAll(caseRe)) {
    const a = attrs(m[1] ?? '')
    const body = m[3] ?? ''
    const fullname = a.fullname ?? a.name ?? `(unnamed case ${total + 1})`
    const result = (a.result ?? '').toLowerCase()
    total++
    let outcome: TestCaseResult['outcome']
    if (result === 'passed') {
      outcome = 'passed'
      passed++
    } else if (result === 'failed') {
      outcome = 'failed'
      failed++
      failures.push(fullname)
    } else if (result === 'skipped') {
      outcome = 'skipped'
      skipped++
    } else if (result === 'inconclusive') {
      outcome = 'skipped'
      inconclusive++
    } else {
      outcome = 'errored'
    }
    let message: string | undefined
    const failureMessage = body.match(/<failure>[\s\S]*?<message>([\s\S]*?)<\/message>/)
    const reasonMessage = body.match(/<reason>[\s\S]*?<message>([\s\S]*?)<\/message>/)
    const stack = body.match(/<stack-trace>([\s\S]*?)<\/stack-trace>/)
    if (failureMessage?.[1] !== undefined) {
      message = decodeXmlText(failureMessage[1].trim())
      if (stack?.[1] !== undefined) {
        message = `${message}\n${decodeXmlText(stack[1].trim())}`
      }
    } else if (reasonMessage?.[1] !== undefined) {
      message = decodeXmlText(reasonMessage[1].trim())
    } else if (result === 'inconclusive') {
      message = 'inconclusive (NUnit)'
    }
    if (cases.length < CASE_CAP) {
      const durationMs = a.duration !== undefined ? Math.round(Number.parseFloat(a.duration) * 1000) : undefined
      cases.push({
        id: fullname,
        outcome,
        ...(message !== undefined && message !== '' ? { message: message.slice(0, MESSAGE_CAP) } : {}),
        ...(Number.isFinite(durationMs) && durationMs !== undefined ? { durationMs } : {}),
      })
    }
  }
  const errored = total - passed - failed - skipped - inconclusive
  const notes: string[] = []
  if (inconclusive > 0) {
    notes.push(`${inconclusive} inconclusive case(s) counted beside skipped (NUnit semantics: no verdict)`)
  }
  const declared = {
    total: toInt(run.total),
    passed: toInt(run.passed),
    failed: toInt(run.failed),
    skipped: toInt(run.skipped),
    inconclusive: toInt(run.inconclusive),
  }
  if (runTag[0].includes('total=') && declared.total !== total) {
    notes.push(
      `declared counts disagree with scanned cases (declared total ${declared.total}, scanned ${total}) — trusting the scanned cases`,
    )
  }
  const durationMs =
    run.duration !== undefined ? Math.round(Number.parseFloat(run.duration) * 1000) : undefined
  return {
    state: 'ok',
    result: run.result ?? '(unstated)',
    counts: { passed, failed, skipped: skipped + inconclusive, errored: Math.max(0, errored) },
    inconclusive,
    cases,
    ...(total > cases.length ? { casesTruncated: total - cases.length } : {}),
    failures,
    ...(Number.isFinite(durationMs) && durationMs !== undefined ? { durationMs } : {}),
    ...(notes.length > 0 ? { verdictNote: notes.join(' · ') } : {}),
  }
}

export function readUnityTestResults(
  root: string,
  mode: 'EditMode' | 'PlayMode',
): UnityTestResultsOutcome | { state: 'absent'; detail: string } {
  const file = unityTestResultsPath(root, mode)
  let xml: string
  try {
    xml = readFileSync(file, 'utf8')
  } catch {
    return {
      state: 'absent',
      detail: `${file} not found — run the unity ${mode} test profile first (operator-run; the Launch tool prints the exact command)`,
    }
  }
  return parseUnityTestResults(xml)
}

export function unityRerunFailedArgs(
  failures: string[],
  root: string,
  mode: 'EditMode' | 'PlayMode',
): string[] {
  return [
    '-runTests',
    '-batchmode',
    '-projectPath',
    root,
    '-testResults',
    unityTestResultsPath(root, mode),
    '-testPlatform',
    mode,
    '-testFilter',
    failures.join(';'),
  ]
}

export function unityRunToRecord(
  parse: UnityTestRunParse,
  opts: {
    root: string
    mode: 'EditMode' | 'PlayMode'
    resultsPath: string
    selection: string
    finishedAt?: number
  },
): TestRunRecord {
  const finishedAt = opts.finishedAt ?? Date.now()
  const durationMs = parse.durationMs ?? 0
  return {
    schema: 1,
    id: `run-${finishedAt}-unity`,
    framework: 'unity',
    selection: opts.selection,
    command: ['unity-bridge:tests_run', opts.mode, opts.resultsPath],
    cwd: opts.root,
    interpreter: 'unity-editor (bridge)',
    startedAt: finishedAt - durationMs,
    durationMs,
    counts: parse.counts,
    cases: parse.cases,
    ...(parse.casesTruncated ? { casesTruncated: parse.casesTruncated } : {}),
    failures: parse.failures,
    outputTail: [],
    exitCode: null,
    ...(parse.verdictNote ? { verdictNote: parse.verdictNote } : {}),
  }
}
