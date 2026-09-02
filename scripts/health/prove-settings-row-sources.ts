#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-settings-row-sources.ts — doctor's Settings row
//  derives its source list (FC-098). The fixed "user + project + local
//  settings parsed" sentence asserted sources the run may never have read:
//  under --setting-sources "" the row still reported the full cascade
//  healthy over an EMPTY one, and the flag/policy layers were never named.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-settings-row-sources.ts
// ============================================================================
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'settings-row-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const settingsRow = async (): Promise<{ status: string; evidence: string }> => {
  const report = await import('../../src/utils/healthReport.js')
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'settings')
  return { status: String(row?.status), evidence: String(row?.evidence) }
}

{
  const row = await settingsRow()
  check(
    'the full cascade names its REAL sources (derived, flag/policy included)',
    row.evidence.startsWith('sources: ') && row.evidence.includes('userSettings') && row.evidence.includes('policySettings'),
    row.evidence,
  )
  check('the fixed user+project+local sentence is gone', !row.evidence.includes('user + project + local settings parsed'))
}
{
  const { setAllowedSettingSources } = await import('../../src/bootstrap/state.js')
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
  setAllowedSettingSources([])
  resetSettingsCache()
  const row = await settingsRow()
  check(
    'a restricted-to-nothing run names ONLY the always-on layers (user/project/local honestly gone)',
    row.evidence.includes('sources: flagSettings + policySettings') &&
      !row.evidence.includes('userSettings') &&
      !row.evidence.includes('projectSettings'),
    row.evidence,
  )
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-settings-row-sources: all green' : `\nprove-settings-row-sources: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
