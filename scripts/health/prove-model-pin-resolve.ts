#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'pin-resolve-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_MODEL
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const modelRow = async (): Promise<{ status: string; evidence: string }> => {
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
  resetSettingsCache()
  const report = await import('../../src/utils/healthReport.js')
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'model')
  return { status: String(row?.status), evidence: String(row?.evidence) }
}

writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ model: 'sonnet5' }))
{
  const row = await modelRow()
  check(
    "an alias pin the session resolves from reads OK ('= settings pin')",
    row.status === 'ok' && row.evidence.includes('= settings pin'),
    `${row.status}: ${row.evidence}`,
  )
}

{
  const { setMainLoopModelOverride } = await import('../../src/bootstrap/state.js')
  setMainLoopModelOverride('opus')
  const row = await modelRow()
  check(
    'a real drift still reads as drift (the override outruns the pin)',
    row.status === 'info' && row.evidence.includes('overrides the pin'),
    `${row.status}: ${row.evidence}`,
  )
  check(
    "… and the drift line names the pin's resolution",
    row.evidence.includes('resolves to'),
    row.evidence,
  )
  setMainLoopModelOverride(null)
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-model-pin-resolve: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-model-pin-resolve: all green')
