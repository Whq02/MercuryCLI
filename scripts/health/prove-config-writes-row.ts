#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-config-writes-row.ts — the config-lock degradation
//  counter has a reader (FC-140). getConfigLocklessFallbackCount was
//  exported and never read anywhere (one grep hit: its own definition),
//  and the accompanying error line is debug-only — nothing told the
//  operator that config writes stopped being serialized. The doctor's new
//  config-writes row is the consumer.
//
//  §1 a clean session reads ok, saying serialized / 0 fallbacks.
//  §2 recorded fallbacks WARN with the count and the racing consequence.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-config-writes-row.ts
// ============================================================================
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'cfgwrites-home-')))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const globalConfig = await import('../../src/utils/config/globalConfig.js')
const report = await import('../../src/utils/healthReport.js')
const row = async (): Promise<{ status: string; evidence: string } | null> => {
  const cert = await report.runHealthReport({ depth: 'fast' })
  const r = cert.sections.flatMap(s => s.checks).find(c => c.id === 'config-writes')
  return r ? { status: String(r.status), evidence: String(r.evidence) } : null
}

console.log('§1 a clean session reads ok')
{
  const clean = await row()
  check('the row exists (config-writes)', clean !== null)
  check(
    'clean reads ok: serialized, 0 fallbacks',
    clean?.status === 'ok' && clean.evidence.includes('0 lockless fallbacks'),
    `${clean?.status}: ${clean?.evidence}`,
  )
}

console.log('\n§2 recorded fallbacks WARN, counted')
{
  globalConfig.noteConfigLocklessFallback()
  globalConfig.noteConfigLocklessFallback()
  const degraded = await row()
  check(
    'two fallbacks warn with the count and the racing consequence',
    degraded?.status === 'warn' &&
      degraded.evidence.includes('2 config write(s)') &&
      degraded.evidence.includes('race'),
    `${degraded?.status}: ${degraded?.evidence}`,
  )
}

console.log(failures === 0 ? '\nprove-config-writes-row: all green' : `\nprove-config-writes-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
