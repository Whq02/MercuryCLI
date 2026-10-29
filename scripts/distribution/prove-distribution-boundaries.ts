#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('signature boundaries — home authority')

{
  delete process.env.MERCURY_CONFIG_DIR
  delete process.env.MERCURY_HOME
  process.env.MERCURY_HOME = '/tmp/sig-proof-home'
  const { crashReportDir } = await import('../../src/utils/crashReport.js')
  check(
    'MERCURY_HOME governs the crash dir',
    crashReportDir().startsWith('/tmp/sig-proof-home'),
    crashReportDir(),
  )
  process.env.MERCURY_CONFIG_DIR = '/tmp/sig-proof-explicit'
  check(
    'explicit MERCURY_CONFIG_DIR wins (compat contract)',
    crashReportDir().startsWith('/tmp/sig-proof-explicit'),
    crashReportDir(),
  )
  delete process.env.MERCURY_CONFIG_DIR
  delete process.env.MERCURY_HOME

  const src = readFileSync(join(ROOT, 'src/utils/crashReport.ts'), 'utf8')
  check(
    'crashReport.ts rides the one config-home resolver',
    src.includes('getMercuryHome'),
  )
}

if (failures > 0) {
  console.log(`\nsignature boundaries: RED (${failures})`)
  process.exit(1)
}
console.log('\nsignature boundaries: green')
