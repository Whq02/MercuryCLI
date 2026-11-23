#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'selfstamp-home-')))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — to fix: ' + hint : ''}`)
  if (!cond) failures++
}

const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')
const report = await import('../../src/platform/health/healthReport.js')
const flagsRow = async (): Promise<{ status: string; evidence: string }> => {
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'flags')
  return { status: String(row?.status), evidence: String(row?.evidence) }
}

console.log('§1 the registry carries the fact')
{
  const row = FLAG_REGISTRY.find(f => f.env === 'MERCURY_ENTRYPOINT') as
    | { selfStamped?: true }
    | undefined
  check('MERCURY_ENTRYPOINT is marked selfStamped', row?.selfStamped === true, '', 'the MERCURY_ENTRYPOINT entry of FLAG_REGISTRY must carry selfStamped: true')
}

console.log("\n§2 the row counts the operator's variables only")
{
  process.env.MERCURY_ENTRYPOINT = 'headless'
  const one = await flagsRow()
  const m = one.evidence.match(/(\d+) flag\(s\) overridden/)
  check(
    'exactly the operator flags are counted — the stamp is outside the count',
    m !== null && !one.evidence.match(/overridden in env:[^·]*MERCURY_ENTRYPOINT/),
    one.evidence.slice(0, 140),
    'flagsCheck in src/platform/health/sections/settings/sources.ts must leave flags with selfStamped true out of the overridden count and the overridden list',
  )
  check(
    'the stamp is still visible, named as not an override',
    one.evidence.includes('self-stamped (not an override): MERCURY_ENTRYPOINT'),
    one.evidence.slice(0, 160),
    'flagsCheck in src/platform/health/sections/settings/sources.ts must append the self-stamped (not an override) note (stampNote) naming each stamped flag',
  )
  const counted = m ? Number(m[1]) : -1
  const operatorSet = FLAG_REGISTRY.filter(
    f => (f as { selfStamped?: true }).selfStamped !== true && process.env[f.env] !== undefined,
  ).length
  check(`the count matches the operator set (${operatorSet})`, counted === operatorSet, `counted=${counted}`, 'flagsCheck in src/platform/health/sections/settings/sources.ts must count exactly the FLAG_REGISTRY flags that are set in the environment and not selfStamped')
}

console.log(failures === 0 ? '\nprove-flags-row-selfstamp: all green' : `\nprove-flags-row-selfstamp: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
