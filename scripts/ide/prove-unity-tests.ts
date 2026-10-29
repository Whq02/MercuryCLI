#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' unity test-results parsing — proof (fixtures)')
console.log('============================================================')

const {
  parseUnityTestResults,
  readUnityTestResults,
  unityRerunFailedArgs,
} = await import('../../src/services/ide/unityTests.js')
const { unityTestResultsPath } = await import('../../src/services/ide/unityProject.js')

const fixtures = path.join(import.meta.dir, 'fixtures', 'unity')
const load = (name: string): string => readFileSync(path.join(fixtures, name), 'utf8')

section('§1 · the pass fixture (the grammar)')
{
  const p = parseUnityTestResults(load('editmode-pass.xml'))
  check('parses ok with the run verdict', p.state === 'ok' && p.result === 'Passed')
  if (p.state === 'ok') {
    check(
      'counts: 3 passed, nothing else',
      p.counts.passed === 3 && p.counts.failed === 0 && p.counts.skipped === 0 && p.counts.errored === 0,
    )
    check('three cases, full names as ids', p.cases.length === 3 && p.cases[0]?.id === 'Game.Tests.HealthTests.SpawnsAtFullHealth')
    check('durations in ms', p.cases[0]?.durationMs === 11)
    check('zero failures; run duration parsed', p.failures.length === 0 && p.durationMs === 1042)
    check('no verdict note on a clean file', p.verdictNote === undefined)
  }
}

section('§2 · the mixed fixture (failure/skip/inconclusive honesty)')
{
  const p = parseUnityTestResults(load('editmode-failures.xml'))
  check('parses ok with the failed verdict', p.state === 'ok' && p.result === 'Failed')
  if (p.state === 'ok') {
    check(
      'counts: 1 passed · 1 failed · 2 skipped-class (skip + inconclusive)',
      p.counts.passed === 1 && p.counts.failed === 1 && p.counts.skipped === 2 && p.counts.errored === 0,
    )
    const failedCase = p.cases.find(c => c.outcome === 'failed')
    check(
      'failed case carries message AND stack (CDATA decoded)',
      failedCase !== undefined &&
        (failedCase.message ?? '').includes('Expected: 5') &&
        (failedCase.message ?? '').includes('CombatTests.cs:42'),
    )
    const skippedCase = p.cases.find(c => c.id.endsWith('CritsDouble'))
    check('skipped case carries its reason', (skippedCase?.message ?? '').includes('crit rework pending'))
    check(
      'inconclusive counted + NAMED in the note',
      p.inconclusive === 1 && (p.verdictNote ?? '').includes('inconclusive'),
    )
    check(
      'failures[] = the failing full names only',
      p.failures.length === 1 && p.failures[0] === 'Game.Tests.CombatTests.DamageIsAdditive',
    )
  }
}

section('§3 · adversarial honesty (rejections + disagreement)')
{
  const malformed = parseUnityTestResults(load('malformed.xml'))
  check(
    'malformed ⇒ typed rejection naming the missing root',
    malformed.state === 'rejected' && malformed.reason.includes('<test-run>'),
  )
  const xxe = parseUnityTestResults(load('entity-doctype.xml'))
  check(
    'DOCTYPE/ENTITY ⇒ REFUSED BY NAME (no entity resolution, ever)',
    xxe.state === 'rejected' && xxe.reason.includes('no entity resolution'),
  )
  check(
    'the refusal happened BEFORE any content parse (no /etc/passwd spelling anywhere)',
    xxe.state === 'rejected' && !JSON.stringify(xxe).includes('passwd'),
  )
  const disagree = parseUnityTestResults(load('counts-disagree.xml'))
  check(
    'declared-vs-scanned disagreement recorded, scanned cases trusted',
    disagree.state === 'ok' &&
      disagree.counts.passed === 1 &&
      (disagree.verdictNote ?? '').includes('declared total 5, scanned 1'),
  )
  const big = parseUnityTestResults('x'.repeat(33 * 1024 * 1024))
  check('oversized input ⇒ typed cap rejection', big.state === 'rejected' && big.reason.includes('cap'))
}

section('§4 · the hand-off seam (rerun respelling + the convention path)')
{
  const args = unityRerunFailedArgs(['A.B.C', 'D.E.F'], '/proj', 'EditMode')
  check(
    'rerun argv: the documented -testFilter shape over the same convention path',
    args[0] === '-runTests' &&
      args[args.indexOf('-testFilter') + 1] === 'A.B.C;D.E.F' &&
      args[args.indexOf('-testResults') + 1] === unityTestResultsPath('/proj', 'EditMode') &&
      !args.includes('-quit'),
  )
  const scratch = mkdtempSync(path.join(tmpdir(), 'unity-tests-'))
  const absent = readUnityTestResults(scratch, 'EditMode')
  check(
    'absent results = a STATE naming the operator road',
    absent.state === 'absent' && absent.detail.includes('operator-run'),
  )
  const dest = unityTestResultsPath(scratch, 'PlayMode')
  mkdirSync(path.dirname(dest), { recursive: true })
  writeFileSync(dest, load('editmode-pass.xml'))
  const read = readUnityTestResults(scratch, 'PlayMode')
  check('present results parse through the same door', read.state === 'ok' && read.counts.passed === 3)
  rmSync(scratch, { recursive: true, force: true })
}

section('§5 · the XML attribute-value model (no backslash escaping)')
{
  const tail = parseUnityTestResults(
    '<test-run result="Failed" total="1" failed="1">' +
      '<test-case fullname="Suite.EndsWithSlash\\" result="Failed"/></test-run>',
  )
  check(
    'value ending in backslash: closing quote honored, following attr not swallowed',
    tail.state === 'ok' &&
      tail.counts.failed === 1 &&
      tail.counts.errored === 0 &&
      tail.failures[0] === 'Suite.EndsWithSlash\\',
    tail.state === 'ok' ? JSON.stringify({ counts: tail.counts, failures: tail.failures }) : tail.reason,
  )
  const param = parseUnityTestResults(
    '<test-run result="Failed" total="1" failed="1">' +
      '<test-case fullname="Suite.PathTest(&quot;C:\\tmp\\&quot;)" result="Failed"/></test-run>',
  )
  check(
    'param\'d-test fullname (&quot; + mid-value backslashes) decodes intact',
    param.state === 'ok' && param.failures[0] === 'Suite.PathTest("C:\\tmp\\")',
    param.state === 'ok' ? JSON.stringify(param.failures) : param.reason,
  )
}

section('§6 · no-hang: the attribute scan is linear, not O(n²)')
{
  const HANG_CEILING_MS = 4_000
  const bigTok = 'a'.repeat(2 * 1024 * 1024)
  for (const [label, xml] of [
    ['bare <test-run> mega-token', `<test-run ${bigTok}>`],
    ['bare <test-case> mega-token', `<test-run total="1"><test-case ${bigTok}/></test-run>`],
  ] as const) {
    const t0 = performance.now()
    const r = parseUnityTestResults(xml)
    const ms = performance.now() - t0
    check(
      `${label}: parses honestly under ${HANG_CEILING_MS}ms (linear scan) — ${Math.round(ms)}ms`,
      r.state === 'ok' && ms < HANG_CEILING_MS,
    )
  }
}

console.log('\n============================================================')
if (failures > 0) {
  console.log(` RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log(' RESULT: all checks passed')
