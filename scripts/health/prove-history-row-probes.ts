#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-history-row-probes.ts — the history doctor row
//  probes the STORE, not only the per-process counters (FC-153): a one-shot
//  doctor run never appends, so its counters are all zero and the row said
//  appends healthy while history.jsonl was a directory no append could
//  land in.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-history-row-probes.ts
// ============================================================================
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'hist-row-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

mkdirSync(join(HOME, 'history.jsonl'))

const historyRow = async (): Promise<{ status: string; evidence: string }> => {
  const report = await import('../../src/utils/healthReport.js')
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'history')
  return { status: String(row?.status), evidence: String(row?.evidence) }
}

const broken = await historyRow()
check(
  'history.jsonl-as-a-DIRECTORY warns on a one-shot run (never appends healthy)',
  broken.status === 'warn' && broken.evidence.includes('DIRECTORY'),
  `${broken.status}: ${broken.evidence.slice(0, 120)}`,
)

rmSync(join(HOME, 'history.jsonl'), { recursive: true, force: true })
const clean = await historyRow()
check('an absent store reads ok (control — nothing has appended yet)', clean.status === 'ok', `${clean.status}: ${clean.evidence.slice(0, 80)}`)

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-history-row-probes: all green' : `\nprove-history-row-probes: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
