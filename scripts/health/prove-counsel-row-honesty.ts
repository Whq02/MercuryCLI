#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'counsel-home-')))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const counsel = (await import('../../src/services/counsel/counsel.js')) as unknown as {
  counselMode: () => string
  counselConfigProblem?: () => string | null
}
const problemOf = counsel.counselConfigProblem ?? ((): string | null => null)

section('§1 THE MODE PARSER')
{
  const modeFor = (v: string | undefined): string => {
    if (v === undefined) delete process.env.MERCURY_COUNSEL
    else process.env.MERCURY_COUNSEL = v
    return counsel.counselMode()
  }
  check("the problem fact is exported (counselConfigProblem)", typeof counsel.counselConfigProblem === 'function')
  check("'yes' arms manual (the truthy family is one vocabulary)", modeFor('yes') === 'manual', modeFor('yes'))
  for (const v of ['manual', '1', 'true', 'on']) {
    check(`'${v}' arms manual`, modeFor(v) === 'manual')
  }
  for (const v of ['auto', 'after-change-batch']) {
    check(`'${v}' arms auto`, modeFor(v) === 'auto')
  }
  check("junk ('sometimes') still fails closed to off", modeFor('sometimes') === 'off')
  check('unset is off', modeFor(undefined) === 'off')
}

section('§2 THE PROBLEM FACT')
{
  delete process.env.MERCURY_COUNSEL
  check('unset ⇒ no problem', problemOf() === null)
  process.env.MERCURY_COUNSEL = 'manual'
  check('recognised ⇒ no problem', problemOf() === null)
  process.env.MERCURY_COUNSEL = 'sometimes'
  const p = problemOf() ?? ''
  check(
    "unrecognised ⇒ names the SET value and the remedy, and says counsel stays off",
    p.includes("'sometimes'") && p.includes('=manual or =auto') && p.includes('off'),
    p,
  )
}

section('§3 THE DOCTOR ROW')
{
  const counselRow = async (): Promise<{ status: string; evidence: string }> => {
    const report = await import('../../src/utils/healthReport.js')
    const cert = await report.runHealthReport({ depth: 'fast' })
    const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'counsel-fast')
    return { status: String(row?.status), evidence: String(row?.evidence) }
  }
  delete process.env.MERCURY_COUNSEL
  const unset = await counselRow()
  check(
    'unset reads as the arm invitation (off row, unchanged)',
    unset.status === 'off' && unset.evidence.includes('unset'),
    `${unset.status}: ${unset.evidence.slice(0, 90)}`,
  )
  process.env.MERCURY_COUNSEL = 'sometimes'
  const junk = await counselRow()
  check(
    "a junk value WARNS naming the real cause — never 'unset'",
    junk.status === 'warn' && junk.evidence.includes("'sometimes'") && !junk.evidence.includes('unset'),
    `${junk.status}: ${junk.evidence.slice(0, 110)}`,
  )
  process.env.MERCURY_COUNSEL = 'yes'
  const armed = await counselRow()
  check(
    '=yes arms (ok row, mode manual)',
    armed.status === 'ok' && armed.evidence.includes('manual'),
    `${armed.status}: ${armed.evidence.slice(0, 90)}`,
  )
  delete process.env.MERCURY_COUNSEL
}

console.log(failures === 0 ? '\nprove-counsel-row-honesty: all green' : `\nprove-counsel-row-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
