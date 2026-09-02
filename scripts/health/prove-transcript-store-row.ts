#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-transcript-store-row.ts — the doctor probes the
//  session transcript store (FC-124). The certificate carried 100+ checks
//  and not one touched <config-home>/projects: with a regular FILE at that
//  path — the store completely unusable, no session recordable or
//  resumable — every storage row read healthy.
//
//  §1 the card's damage: projects as a regular file ⇒ FAIL naming the
//     store, with a remedy.
//  §2 absence is normal (first session creates it) ⇒ ok, said.
//  §3 a healthy directory ⇒ ok with the count, writable.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-transcript-store-row.ts
// ============================================================================
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'tstore-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const report = await import('../../src/utils/healthReport.js')
const storeRow = async (): Promise<{ status: string; evidence: string } | null> => {
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'transcript-store')
  return row ? { status: String(row.status), evidence: String(row.evidence) } : null
}

console.log('§1 the damage the card names')
{
  writeFileSync(join(HOME, 'projects'), 'not a directory\n')
  const row = await storeRow()
  check('the row exists (transcript-store)', row !== null)
  check(
    'a regular file at projects/ FAILS naming the unusable store',
    row?.status === 'fail' && row.evidence.includes('not a directory') && row.evidence.includes('transcripts'),
    `${row?.status}: ${row?.evidence}`,
  )
}

console.log('\n§2 absence is normal, and said')
{
  const HOME2 = realpathSync(mkdtempSync(join(tmpdir(), 'tstore-fresh-')))
  process.env.MERCURY_CONFIG_DIR = HOME2
  const row = await storeRow()
  check(
    'a fresh home reads ok with the first-session sentence',
    row?.status === 'ok' && row.evidence.includes('first session creates it'),
    `${row?.status}: ${row?.evidence}`,
  )
}

console.log('\n§3 a healthy store reads ok, counted')
{
  const HOME3 = realpathSync(mkdtempSync(join(tmpdir(), 'tstore-ok-')))
  process.env.MERCURY_CONFIG_DIR = HOME3
  mkdirSync(join(HOME3, 'projects', 'p1'), { recursive: true })
  mkdirSync(join(HOME3, 'projects', 'p2'), { recursive: true })
  const row = await storeRow()
  check(
    'a healthy directory reads ok, counted and writable',
    row?.status === 'ok' && row.evidence.includes('2 project dir(s)') && row.evidence.includes('writable'),
    `${row?.status}: ${row?.evidence}`,
  )
}

console.log(failures === 0 ? '\nprove-transcript-store-row: all green' : `\nprove-transcript-store-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
