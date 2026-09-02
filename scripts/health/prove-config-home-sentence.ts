#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-config-home-sentence.ts — the config-home row's
//  sentence follows its own test (FC-154). MERCURY_DAEMON_DIR suppresses
//  the daemon-plane split TEST by design, but the row then asserted
//  "global config + daemon plane inside the home" anyway — a claim about a
//  plane the operator had pointed elsewhere.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-config-home-sentence.ts
// ============================================================================
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-home-')))
const DAEMON = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-daemon-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const homeRow = async (): Promise<{ status: string; evidence: string }> => {
  const report = await import('../../src/utils/healthReport.js')
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'config-home')
  return { status: String(row?.status), evidence: String(row?.evidence) }
}

process.env.MERCURY_DAEMON_DIR = DAEMON
const overridden = await homeRow()
check(
  'an overridden daemon plane is NAMED where it went — never claimed inside the home',
  overridden.evidence.includes('daemon plane OVERRIDDEN') &&
    overridden.evidence.includes(DAEMON) &&
    !overridden.evidence.includes('daemon plane inside the home'),
  `${overridden.status}: ${overridden.evidence.slice(0, 160)}`,
)
delete process.env.MERCURY_DAEMON_DIR

rmSync(HOME, { recursive: true, force: true })
rmSync(DAEMON, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-config-home-sentence: all green' : `\nprove-config-home-sentence: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
