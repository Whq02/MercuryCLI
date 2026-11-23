#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'color-home-')))
process.env.NODE_ENV = 'test'
delete process.env.NO_COLOR
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — to fix: ' + hint : ''}`)
  if (!cond) failures++
}

const chalk = (await import('chalk')).default
const report = await import('../../src/platform/health/healthReport.js')

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
    'colorCheck in src/platform/health/sections/runtime/host.ts must word the chalk level 1 row as basic 16-color ANSI and never as 256-color',
  )
  const l2 = await colorRow(2, true)
  check('level 2 keeps the 256-color reading', l2.evidence.includes('256-color'), l2.evidence, 'colorCheck in src/platform/health/sections/runtime/host.ts must keep the 256-color wording for chalk level 2')
  const l0 = await colorRow(0, true)
  check('level 0 keeps the no-color reading', l0.evidence.includes('no color'), l0.evidence, 'colorCheck in src/platform/health/sections/runtime/host.ts must keep the no color wording for chalk level 0')
}

console.log('\n§2 FC-120 — computed is not applied')
{
  const appliedL3 = await colorRow(3, true)
  check(
    'level 3 on a real TTY reads ok with exact brand hues, unqualified',
    appliedL3.status === 'ok' && appliedL3.evidence.includes('brand hues exact') && !appliedL3.evidence.includes('not a TTY'),
    `${appliedL3.status}: ${appliedL3.evidence}`,
    'colorCheck in src/platform/health/sections/runtime/host.ts must return status ok with brand hues exact and no not-a-TTY note when chalk level is 3 and stdout is a TTY',
  )
  const forcedL3 = await colorRow(3, false)
  check(
    'level 3 with redirected stdout is NEVER ok — the row says the output itself carries no color',
    forcedL3.status === 'info' && forcedL3.evidence.includes('not a TTY') && forcedL3.evidence.includes('carries no color'),
    `${forcedL3.status}: ${forcedL3.evidence}`,
    'colorCheck in src/platform/health/sections/runtime/host.ts must return status info and the not-a-TTY, carries no color note when stdout is not a TTY, whatever the chalk level',
  )
  const forcedL1 = await colorRow(1, false)
  check('the qualifier rides the lower levels too', forcedL1.evidence.includes('not a TTY'), forcedL1.evidence, 'colorCheck in src/platform/health/sections/runtime/host.ts must append the not-a-TTY note (appliedNote) on the level 1 and level 2 rows too')
}

console.log(failures === 0 ? '\nprove-color-row-honesty: all green' : `\nprove-color-row-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
