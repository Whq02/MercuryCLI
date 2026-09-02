#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-color-row-honesty.ts — the doctor color row speaks
//  the truth on two axes (FC-119 · FC-120).
//
//  FC-119: chalk level 1 is basic 16-color ANSI, but the row's fall-through
//  wore the hardcoded 256-color label for every level that was neither 0
//  nor 3.
//  FC-120: under a FORCE_COLOR-style override the row reported "chalk
//  level 3 — truecolor — brand hues exact" about a redirected run whose
//  output carries zero escape bytes — contradicting the terminal-profile
//  row directly above it. The level is computed; the claim must say when
//  it is not APPLIED, and an un-applied level is never 'ok'.
//
//  Matrix over the live row (chalk.level assigned, stdout.isTTY faked with
//  descriptor restore — the established faked-TTY pattern).
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-color-row-honesty.ts
// ============================================================================
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'color-home-')))
process.env.NODE_ENV = 'test'
delete process.env.NO_COLOR
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const chalk = (await import('chalk')).default
const report = await import('../../src/utils/healthReport.js')

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
const setTTY = (v: boolean): void => {
  Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true })
}
const restoreTTY = (): void => {
  if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor)
  else delete (process.stdout as { isTTY?: boolean }).isTTY
}

const colorRow = async (level: 0 | 1 | 2 | 3, tty: boolean): Promise<{ status: string; evidence: string }> => {
  const savedLevel = chalk.level
  chalk.level = level
  setTTY(tty)
  try {
    const cert = await report.runHealthReport({ depth: 'fast' })
    const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'color')
    return { status: String(row?.status), evidence: String(row?.evidence) }
  } finally {
    chalk.level = savedLevel
    restoreTTY()
  }
}

console.log('§1 FC-119 — each level wears its own name')
{
  const l1 = await colorRow(1, true)
  check(
    'level 1 says basic 16-color ANSI, never 256',
    l1.evidence.includes('basic 16-color') && !l1.evidence.includes('256-color'),
    l1.evidence,
  )
  const l2 = await colorRow(2, true)
  check('level 2 keeps the 256-color reading', l2.evidence.includes('256-color'), l2.evidence)
  const l0 = await colorRow(0, true)
  check('level 0 keeps the no-color reading', l0.evidence.includes('no color'), l0.evidence)
}

console.log('\n§2 FC-120 — computed is not applied')
{
  const appliedL3 = await colorRow(3, true)
  check(
    'level 3 on a real TTY reads ok with exact brand hues, unqualified',
    appliedL3.status === 'ok' && appliedL3.evidence.includes('brand hues exact') && !appliedL3.evidence.includes('not a TTY'),
    `${appliedL3.status}: ${appliedL3.evidence}`,
  )
  const forcedL3 = await colorRow(3, false)
  check(
    'level 3 with redirected stdout is NEVER ok — the row says the output itself carries no color',
    forcedL3.status === 'info' && forcedL3.evidence.includes('not a TTY') && forcedL3.evidence.includes('carries no color'),
    `${forcedL3.status}: ${forcedL3.evidence}`,
  )
  const forcedL1 = await colorRow(1, false)
  check('the qualifier rides the lower levels too', forcedL1.evidence.includes('not a TTY'), forcedL1.evidence)
}

console.log(failures === 0 ? '\nprove-color-row-honesty: all green' : `\nprove-color-row-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
