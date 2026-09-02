#!/usr/bin/env bun
// prove-model-pin-resolve — FC-074: doctor's Model pins row resolves the
// settings pin through the ONE resolver before comparing. The raw string
// compare graded every documented alias spelling — sonnet5, opus, the
// picker labels the fold resolves — as "the live session overrides the
// pin", with only an already-canonical id reading ok.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'pin-resolve-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
delete process.env.ANTHROPIC_MODEL
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

// An ALIAS pin that also drives the session (no override set): the session
// resolves FROM this pin, so the two must read equal once both sides
// resolve — the raw compare called this drift.
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ model: 'sonnet5' }))
{
  const row = await modelRow()
  check(
    "an alias pin the session resolves from reads OK ('= settings pin')",
    row.status === 'ok' && row.evidence.includes('= settings pin'),
    `${row.status}: ${row.evidence}`,
  )
}

// A REAL drift still reads as drift, with the pin's resolution named.
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
