#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-themis-level-words.ts — the themis row's evidence
//  distinguishes audit-only from enforcing (FC-149). warn and enforce used
//  to render byte-identically apart from the level token — "blocklist
//  armed at the execution gate" over a gate that denies nothing at warn.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-themis-level-words.ts
// ============================================================================
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'themis-words-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const themisRow = async (): Promise<string> => {
  const report = await import('../../src/utils/healthReport.js')
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'themis')
  return String(row?.evidence)
}

process.env.MERCURY_THEMIS = 'warn'
const warnEvidence = await themisRow()
process.env.MERCURY_THEMIS = 'enforce'
const enforceEvidence = await themisRow()
delete process.env.MERCURY_THEMIS

check(
  'warn says OBSERVING and that the gate never denies',
  warnEvidence.includes('blocklist OBSERVING at the execution gate') && warnEvidence.includes('never denied'),
  warnEvidence.slice(0, 120),
)
check(
  'enforce says the blocklist is ENFORCED (matching calls denied)',
  enforceEvidence.includes('blocklist ENFORCED at the execution gate') && enforceEvidence.includes('denied'),
  enforceEvidence.slice(0, 120),
)
check('neither level is painted as armed', !/\barmed\b/.test(warnEvidence) && !/\barmed\b/.test(enforceEvidence))
check(
  'the two levels are distinguishable by MORE than the token',
  warnEvidence.replace(/level=warn/, 'level=X') !== enforceEvidence.replace(/level=enforce/, 'level=X'),
)

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-themis-level-words: all green' : `\nprove-themis-level-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
