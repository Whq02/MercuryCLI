#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..')
let failures = 0
let count = 0
function check(label: string, cond: boolean, detail = ''): void {
  count++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-proof' }
process.chdir(mkdtempSync(join(tmpdir(), 'cache-clock-gate-')))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cache-clock-gate-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const k of ['MERCURY_CACHE_CLOCK', 'MERCURY_CACHE_TTL', 'MERCURY_TANK', 'MERCURY_HEALER', 'MERCURY_DAEMON_PERMISSION_MODE', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_UNIX_SOCKET']) delete process.env[k]
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

const state = await import('../../src/bootstrap/state.ts')
const clock = await import('../../src/utils/cache/cacheClock.ts')
const params = await import('../../src/services/providers/anthropic/requestParams.ts')
const j = (v: unknown): string => JSON.stringify(v)
const minutes = (n: number): number => n * 60_000
type Snapshot = ReturnType<typeof clock.cacheClockSnapshot> & { reason?: string | null }
const snapshot = (): Snapshot => clock.cacheClockSnapshot() as Snapshot
const control = (): { type: string; ttl?: string } => params.getCacheControl()
state.setIsInteractive(true)

section('§1 a key-billed seat: the clock stays off and the reading says which gate held (the field row M39-03, 1B-02)')
{
  clock.resetCacheClockForTesting()
  state.setPromptCache1hEligible(null)
  state.setLastApiCompletionTimestamp(null)
  const first = control()
  const before = snapshot()
  check('an Anthropic console key is not eligible: the first request rides the 5m tier', first.ttl === undefined && before.engaged === false, j({ first, before }))
  check('the snapshot names the gate that held in this home (no claude.ai sign-in stored) and the pin that is the consent', typeof before.reason === 'string' && before.reason.startsWith('no claude.ai sign-in is stored for this home') && before.reason.includes('MERCURY_CACHE_TTL=1h pins it as billing consent'), j(before))
  const reading = (params as { promptCache1hEligibility?: () => { eligible: boolean; reason: string | null } }).promptCache1hEligibility?.()
  check('the eligibility reading carries the same words for the surfaces', reading !== undefined && reading.eligible === false && reading.reason === before.reason, j(reading))
  state.setLastApiCompletionTimestamp(Date.now() - minutes(10))
  const after = control()
  check('a 10-minute gap on a key-billed seat still rides the 5m tier (no consent, no premium)', after.ttl === undefined && snapshot().engaged === false, j({ after, snap: snapshot() }))
}

section('§2 a seat that becomes eligible: the clock engages at a cold boundary, never on a warm prefix')
{
  clock.resetCacheClockForTesting()
  state.setPromptCache1hEligible(null)
  state.setLastApiCompletionTimestamp(null)
  const latchedOff = clock.cacheClockTtlDecision({ eligible: false, ineligible: 'the claude.ai account is on extra usage (fixture)', lastCompletionAt: null, now: Date.now() })
  check('the first request latches the clock off with the gate words', latchedOff === null && snapshot().engaged === false && snapshot().reason === 'the claude.ai account is on extra usage (fixture)', j(snapshot()))
  const warm = clock.cacheClockTtlDecision({ eligible: true, lastCompletionAt: Date.now() - 5_000, now: Date.now() })
  check('eligibility restored 5 s after the last completion: the prefix is warm, so nothing flips', warm === null && snapshot().engaged === false, j({ warm, snap: snapshot() }))
  const cold = clock.cacheClockTtlDecision({ eligible: true, lastCompletionAt: Date.now() - minutes(10), now: Date.now() })
  check('eligibility restored at a cold boundary (10 min): the clock engages and the same gap escalates to the 1h tier', cold === '1h' && snapshot().engaged === true && snapshot().ttl === '1h' && snapshot().reason === null, j({ cold, snap: snapshot() }))
  const next = clock.cacheClockTtlDecision({ eligible: false, ineligible: 'the claude.ai account is on extra usage (fixture)', lastCompletionAt: Date.now() - 5_000, now: Date.now() })
  check('once engaged, a later eligibility move never un-engages the clock (the latch holds)', next === '1h' && snapshot().engaged === true, j({ next, snap: snapshot() }))
}

section('§3 the reading when no request has gone out, and the health probe words')
{
  clock.resetCacheClockForTesting()
  const fresh = snapshot()
  check('before any Anthropic request the reading says so, not "not eligible"', fresh.engaged === false && fresh.reason === 'no Anthropic request has gone out in this process', j(fresh))
  process.env.MERCURY_CACHE_CLOCK = '0'
  const off = snapshot()
  check('with the clock off the reading names the flag', off.engaged === false && off.reason === 'the clock is off (MERCURY_CACHE_CLOCK=0)', j(off))
  delete process.env.MERCURY_CACHE_CLOCK
  const health = readFileSync(join(repoRoot, 'src/utils/healthReport.ts'), 'utf8')
  check("the health probe's off row carries the reason", health.includes('clock not engaged this session: ${snap.reason'), '')
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('CACHE CLOCK GATE WORDS RED')
  process.exit(1)
}
console.log('CACHE CLOCK GATE WORDS GREEN')
