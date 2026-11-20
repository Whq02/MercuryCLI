#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn35-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function runUsageHistoryRows(): Promise<void> {
  const { readUsageHistory, recordUsageObservations } = await import('../../src/utils/usageHistory.ts')
  const storeFile = join(HOME, 'usage-history.json')
  const at = Date.parse('2026-10-23T12:00:00Z')
  const seeded = await recordUsageObservations('fixture', 'acct-1', [{ key: '5h', state: 'live', observedAtMs: at, usedPct: 42 }])
  check('usageHistory: seed store written', seeded === true)
  const before = readFileSync(storeFile, 'utf8')
  if (POSIX_MODES) {
    chmodSync(storeFile, 0o200)
    try {
      const wrote = await recordUsageObservations('fixture', 'acct-2', [{ key: '5h', state: 'live', observedAtMs: at + 1000, usedPct: 99 }])
      const report = await readUsageHistory()
      chmodSync(storeFile, 0o600)
      const after = readFileSync(storeFile, 'utf8')
      check('usageHistory: unreadable store refuses overwrite on recordUsageObservations', wrote === false && after === before, `wrote=${String(wrote)} preserved=${String(after === before)}`)
      check('usageHistory: unreadable store warns and stays intact on readUsageHistory', report.warnings.length > 0 && after === before, JSON.stringify(report.warnings))
    } finally {
      chmodSync(storeFile, 0o600)
    }
  }
}

try {
  await runUsageHistoryRows()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
