// ============================================================================
//  ide/unityTests — Unity Test Runner results-XML → the test-record grammar
//  (MERCURY_UNITY estate; pure parsing, executes nothing).
//
//  The Unity Test Framework writes results in "the XML format as defined by
//  NUnit" (docs.unity3d.com 6000.3 test-framework reference-command-line,
//  read 2026-08-29): a <test-run> root carrying result/total/passed/failed/
//  inconclusive/skipped counts over nested <test-suite>/<test-case> nodes,
//  each case with fullname/result/duration and a <failure><message>/
//  <stack-trace> (CDATA) on failing cases. This module parses that file
//  into EXACTLY the vocabulary the pytest lane set (TestCaseResult /
//  TestRunRecord counts + failures), so every Test surface speaks one
//  grammar. THE STORE INTEGRATION IS LIVE: the UNITY-BRIDGE
//  executor landed (the Unity tool's tests_run), so unityRunToRecord below
//  turns a parse into a TestRunRecord (framework 'unity' — the union
//  widened ADDITIVELY in pythonTests.ts, the store owner) and the Unity
//  tool persists it through the store's own writer on the
//  test_run_finished event drain. The boundary sentence that stood here
//  ("the union stays untouched until an in-product executor exists") is
//  re-cut because its constraint is DEAD — leaving it standing would be
//  the lie class.
//
//  THE HAND-OFF SEAM (test failure → debugger, named for the drill): a
//  parsed failure list is a -testFilter respelling — Unity reruns exactly
//  those tests with `-runTests … -testFilter "A;B"` (semicolon-separated
//  full names per the same doc page) — and DEBUGGING them is the landed
//  unity attach road (services/dap/unityAdapter.ts): breakpoints in the
//  test file, attach to the running editor, run the tests from the editor's
//  Test Runner. unityRerunFailedArgs builds the rerun argv purely.
//
//  SECURITY (bounded parser, pinned): DOCTYPE/ENTITY markup is REFUSED by
//  name — no entity resolution exists here, ever (the XXE class); input is
//  size-capped; per-case messages are bounded; the case list caps at the
//  store's own 200 with the truncation counted honestly.
//
//  Proof: scripts/ide/prove-unity-tests.ts over the captured-shape fixtures
//  in scripts/ide/fixtures/unity/ (pass · failures · malformed · DOCTYPE ·
//  counts-disagreement).
// ============================================================================

import { readFileSync } from 'node:fs'
import type { TestCaseResult, TestRunRecord } from './pythonTests.js'
import { unityTestResultsPath } from './unityProject.js'

const INPUT_CAP_BYTES = 32 * 1024 * 1024
const CASE_CAP = 200
const MESSAGE_CAP = 2_000

export interface UnityTestRunParse {
  state: 'ok'
  /** The <test-run> result attribute verbatim ('Passed' | 'Failed' | …). */
  result: string
  counts: { passed: number; failed: number; skipped: number; errored: number }
  /** NUnit 'Inconclusive' cases (mapped to skipped; the note names it). */
  inconclusive: number
  cases: TestCaseResult[]
  casesTruncated?: number
  /** Failing full names — the -testFilter rerun selection vocabulary. */
  failures: string[]
  durationMs?: number
  /** Declared-counts vs scanned-cases disagreement, and the inconclusive
   *  mapping when present (recorded, never hidden). */
  verdictNote?: string
}

export interface UnityTestRunRejected {
  state: 'rejected'
  reason: string
}

export type UnityTestResultsOutcome = UnityTestRunParse | UnityTestRunRejected

function decodeXmlText(raw: string): string {
  // CDATA first (verbatim), then the five predefined references ONLY —
  // there is deliberately no other entity handling here.
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
  // XML attribute values carry NO backslash escaping — a literal `"` inside a
  // value is always `&quot;`, so the delimiter is the next raw `"` and the
  // value class is simply [^"]. (The old `\\.` escape model was C/JSON, not
  // XML: it swallowed the closing quote of any value ending in a backslash
  // and merged the following attribute — dropping, e.g., a case's `result`.)
  //
  // The name quantifier is BOUNDED ({0,63}, so ≤64 chars — every real NUnit
  // attribute name is well under that). Unbounded, the greedy `[\w.-]*`
  // rescanned a long unquoted run from every start offset, making this global
  // scan O(n²) on a single oversized tag: a `<test-case>` with a multi-megabyte
  // attribute-less token (legal under the 32MiB input cap) took minutes,
  // violating the never-hang contract. Bounded, each failed start costs O(64),
  // so the scan is linear in the tag length.
  for (const m of tag.matchAll(/([A-Za-z][\w.-]{0,63})="([^"]*)"/g)) {
    if (m[1] !== undefined && m[2] !== undefined) out[m[1]] = decodeXmlText(m[2])
  }
  return out
}

function toInt(v: string | undefined): number {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Parse a Unity Test Runner results file (NUnit-format XML) into the
 * test-record grammar. Never throws: malformed/oversized/entity-bearing
 * input answers a typed rejection naming why.
 */
export function parseUnityTestResults(xml: string): UnityTestResultsOutcome {
  if (Buffer.byteLength(xml, 'utf8') > INPUT_CAP_BYTES) {
    return { state: 'rejected', reason: `results file exceeds the ${INPUT_CAP_BYTES / (1024 * 1024)}MiB parser cap` }
  }
  // The XXE class, refused BY NAME: this parser resolves no entities and
  // reads no DTDs — a results file carrying them is not a Unity results
  // file this module will touch.
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
  // <test-case …> elements: self-closing (passed, usually) or spanned
  // (failure/reason children). Lexical scan, bounded by the input cap.
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
      // NUnit inconclusive = not run to a verdict; counted beside skipped
      // and NAMED in the verdict note (never silently a pass or fail).
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

/** Read + parse the conventional results file the unity test profiles
 *  write (.mercury/unity-test-results/<mode>.xml). Absence is a STATE. */
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

/**
 * THE RERUN HALF OF THE HAND-OFF SEAM: the exact headless argv that reruns
 * ONLY the parsed failures (-testFilter takes semicolon-separated full
 * names — the same doc page). Pure spelling; running it stays the
 * operator's act, and debugging it is the unity attach road.
 */
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

/**
 * THE STORE HALF OF THE EXECUTOR SEAM: a parsed bridge-run result → the ONE
 * test-run store's record shape (framework 'unity'). No process ran
 * Mercury-side, so the argv-shaped fields carry the bridge spelling
 * honestly instead of pretending: command names the bridge op, interpreter
 * names the editor, exitCode is null. startedAt is finishedAt minus the
 * parsed duration (the editor owns the true start; the approximation is
 * the honest best available and durationMs itself is exact). The id rides
 * the store's own `run-` grammar so listRuns/report/rerun-failed serve
 * bridge runs with zero second ledgers.
 */
export function unityRunToRecord(
  parse: UnityTestRunParse,
  opts: {
    root: string
    mode: 'EditMode' | 'PlayMode'
    resultsPath: string
    /** The store's selection vocabulary; the Unity tool passes what it
     *  knows ('all' | 'nodes:<n>'; a drain without the memo records the
     *  honest fallback). */
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
