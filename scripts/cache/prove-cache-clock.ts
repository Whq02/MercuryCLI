#!/usr/bin/env bun
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-proof' }
process.chdir(mkdtempSync(join(tmpdir(), 'cache-clock-proof-')))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cache-clock-proof-home-'))
for (const k of [
  'MERCURY_CACHE_CLOCK',
  'MERCURY_CACHE_TTL',
  'MERCURY_TANK',
  'MERCURY_HEALER',
  'MERCURY_DAEMON_PERMISSION_MODE',
]) {
  delete process.env[k]
}

const core = await import('../../src/utils/cache/cacheClockCore.ts')
const {
  CACHE_COST,
  TTL_MS,
  classifyGap,
  decideInitialTtl,
  newSimCacheState,
  priorFromRollups,
  shouldEscalate,
  stepCache,
} = core

console.log('============================================================')
console.log(' Cache Clock — proof')
console.log('============================================================')

section('§1 CORE — decision table')
const base = {
  enabled: true,
  pin: null,
  eligible: true,
  cls: 'interactive' as const,
  prior: { sessions: 0, gapSessions: 0 },
}
check('disabled ⇒ null (default path)', decideInitialTtl({ ...base, enabled: false }) === null)
check(
  "pin '1h' wins even when ineligible (explicit billing consent)",
  decideInitialTtl({ ...base, eligible: false, pin: '1h' })?.ttl === '1h',
)
check("pin '5m' wins over a strong prior", (() => {
  const d = decideInitialTtl({ ...base, pin: '5m', prior: { sessions: 10, gapSessions: 9 } })
  return d?.ttl === '5m' && d.escalation === false
})())
check('ineligible without a pin ⇒ null', decideInitialTtl({ ...base, eligible: false }) === null)
check("worker ⇒ upfront '1h', no escalation", (() => {
  const d = decideInitialTtl({ ...base, cls: 'worker' })
  return d?.ttl === '1h' && d.escalation === false
})())
check("interactive, prior ≥3 sessions & share ≥0.4 ⇒ upfront '1h'", (() => {
  const d = decideInitialTtl({ ...base, prior: { sessions: 5, gapSessions: 2 } })
  return d?.ttl === '1h' && d.escalation === false
})())
check("interactive, share just below 0.4 ⇒ '5m' + escalation", (() => {
  const d = decideInitialTtl({ ...base, prior: { sessions: 10, gapSessions: 3 } })
  return d?.ttl === '5m' && d.escalation === true
})())
check("interactive, thin prior (<3 sessions) ⇒ '5m' + escalation", (() => {
  const d = decideInitialTtl({ ...base, prior: { sessions: 2, gapSessions: 2 } })
  return d?.ttl === '5m' && d.escalation === true
})())
check("headless ⇒ '5m' + escalation regardless of prior", (() => {
  const d = decideInitialTtl({ ...base, cls: 'headless', prior: { sessions: 10, gapSessions: 10 } })
  return d?.ttl === '5m' && d.escalation === true
})())

section('§1 CORE — escalation predicate + gap classifier (boundaries)')
const esc = { ttl: '5m' as const, escalation: true }
check('gap exactly 5m does NOT escalate', !shouldEscalate(esc, TTL_MS['5m']))
check('gap 5m+1ms escalates', shouldEscalate(esc, TTL_MS['5m'] + 1))
check('gap exactly 1h escalates (inclusive upper bound)', shouldEscalate(esc, TTL_MS['1h']))
check('gap 1h+1ms does NOT escalate (abandonment, not cadence)', !shouldEscalate(esc, TTL_MS['1h'] + 1))
check('already-1h never escalates', !shouldEscalate({ ttl: '1h', escalation: true }, TTL_MS['5m'] + 1))
check('escalation:false never escalates', !shouldEscalate({ ttl: '5m', escalation: false }, TTL_MS['5m'] + 1))
check(
  'classifyGap boundaries: 5m none / 5m+1 over5m / 1h over5m / 1h+1 over1h',
  classifyGap(TTL_MS['5m']) === 'none' &&
    classifyGap(TTL_MS['5m'] + 1) === 'over5m' &&
    classifyGap(TTL_MS['1h']) === 'over5m' &&
    classifyGap(TTL_MS['1h'] + 1) === 'over1h',
)

section('§1 CORE — cache state machine')
{
  const s = newSimCacheState('5m')
  const first = stepCache(s, 1_000_000, 1000)
  check(
    'first request: full write at 1.25×, no read, not a cold rewrite',
    first.readTokens === 0 && first.writtenTokens === 1000 &&
      Math.abs(first.costUnits - 1250) < 1e-9 && !first.coldRewrite,
  )
  const warm = stepCache(s, 1_000_000 + 60_000, 1200)
  check(
    'warm growth: reads prior prefix at 0.1×, writes the delta',
    warm.readTokens === 1000 && warm.writtenTokens === 200 &&
      Math.abs(warm.costUnits - (100 + 250)) < 1e-9,
  )
  const cold = stepCache(s, 1_000_000 + 60_000 + TTL_MS['5m'] + 1, 1300)
  check(
    'expired: full rewrite, flagged coldRewrite',
    cold.readTokens === 0 && cold.writtenTokens === 1300 && cold.coldRewrite,
  )
  const shrunk = stepCache(s, s.lastUseAtMs! + 1000, 400)
  check(
    'content-bust: prompt <60% of prefix ⇒ full miss (not a TTL cold)',
    shrunk.readTokens === 0 && shrunk.writtenTokens === 400 && !shrunk.coldRewrite,
  )
}
{
  const s = newSimCacheState('5m')
  stepCache(s, 0, 1000)
  const at = TTL_MS['5m'] + 60_000
  const escStep = stepCache(s, at, 1000, '1h')
  check(
    'escalation step: expired under old 5m ttl (cold rewrite)',
    escStep.coldRewrite && escStep.readTokens === 0 && escStep.writtenTokens === 1000,
  )
  check(
    'escalation step: rewrite priced at the 1h premium (2×)',
    Math.abs(escStep.costUnits - 1000 * CACHE_COST.write1h) < 1e-9,
  )
  check("state carries ttl '1h' after the escalation step", s.ttl === '1h')
  const after = stepCache(s, at + 30 * 60_000, 1000)
  check(
    'post-escalation 30m gap is now WARM (read at 0.1×)',
    after.readTokens === 1000 && Math.abs(after.costUnits - 100) < 1e-9,
  )
}

section('§2 INVARIANT — TTL-FLIP-AT-COLD-ONLY (sequence property)')
{
  const gapGrid = [
    0, 1_000, 60_000, TTL_MS['5m'], TTL_MS['5m'] + 1, 10 * 60_000,
    TTL_MS['1h'], TTL_MS['1h'] + 1, 2 * TTL_MS['1h'],
  ]
  let holds = true
  let flips = 0
  for (const g1 of gapGrid) {
    for (const g2 of gapGrid) {
      for (const g3 of gapGrid) {
        let decision = decideInitialTtl({
          enabled: true, pin: null, eligible: true, cls: 'interactive',
          prior: { sessions: 0, gapSessions: 0 },
        })!
        let prevTtl = decision.ttl
        for (const gap of [g1, g2, g3]) {
          if (shouldEscalate(decision, gap)) {
            decision = { ttl: '1h', escalation: false }
          }
          if (decision.ttl !== prevTtl) {
            flips++
            if (gap <= TTL_MS[prevTtl]) holds = false
          }
          prevTtl = decision.ttl
        }
      }
    }
  }
  check(`every TTL flip sits at a provably-cold boundary (${flips} flips examined)`, holds)
  check('the grid actually exercised flips', flips > 0)
}

section('§1 CORE — prior fold tolerates junk')
{
  const prior = priorFromRollups([
    null, 'garbage', 42, { v: 2, requests: 9 }, { v: 1, requests: 0 },
    { v: 1, requests: 5, gapsOver5m: 1 }, { v: 1, requests: 9, gapsOver5m: 0 },
  ])
  check(
    'junk rows ignored; only valid v1 rollups fold',
    prior.sessions === 2 && prior.gapSessions === 1,
  )
}

section('§3 SHELL — stamp-sim drive (real module, scratch cwd)')
const shell = await import('../../src/utils/cache/cacheClock.ts')
const {
  cacheClockObserve,
  cacheClockSnapshot,
  cacheClockTtlDecision,
  resetCacheClockForTesting,
} = shell
const NOW = 1_800_000_000_000

process.env.MERCURY_CACHE_CLOCK = '0'
resetCacheClockForTesting()
check(
  'OFF (=0) ⇒ null — the base should1hCacheTTL path decides',
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: NOW }) === null,
)
delete process.env.MERCURY_CACHE_CLOCK

resetCacheClockForTesting()
check(
  "ON, interactive, thin prior ⇒ '5m'",
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: NOW }) === '5m',
)
check(
  'snapshot reflects the latch (non-worker class under a headless proof run)',
  (() => {
    const s = cacheClockSnapshot()
    return s.engaged && s.ttl === '5m' && s.cls !== 'worker' && !s.escalated
  })(),
)
check(
  'latch is stable across calls (same decision, no drift)',
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: NOW - 1000, now: NOW }) === '5m',
)
check(
  "live escalation at a (5m,1h] cold boundary ⇒ '1h'",
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: NOW - 10 * 60_000, now: NOW }) === '1h',
)
check('snapshot records the escalation', cacheClockSnapshot().escalated)

resetCacheClockForTesting()
check(
  'ineligible without a pin ⇒ null (base path)',
  cacheClockTtlDecision({ eligible: false, lastCompletionAt: null, now: NOW }) === null,
)

process.env.MERCURY_CACHE_TTL = '1h'
resetCacheClockForTesting()
check(
  "operator pin '1h' wins while ineligible",
  cacheClockTtlDecision({ eligible: false, lastCompletionAt: null, now: NOW }) === '1h',
)
delete process.env.MERCURY_CACHE_TTL

process.env.MERCURY_DAEMON_PERMISSION_MODE = 'flow'
resetCacheClockForTesting()
check(
  "worker classing from daemon child env ⇒ upfront '1h'",
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: NOW }) === '1h' &&
    cacheClockSnapshot().cls === 'worker',
)
delete process.env.MERCURY_DAEMON_PERMISSION_MODE

section('§3 SHELL — rollup persistence (the cadence prior on disk)')
{
  resetCacheClockForTesting()
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: NOW })
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: NOW - 10 * 60_000, now: NOW })
  for (let i = 0; i < 9; i++) {
    cacheClockObserve({
      cacheReadTokens: 10_000, cacheCreationTotal: 1_000,
      cacheCreation5m: null, cacheCreation1h: null,
      uncachedInputTokens: 100, now: NOW + i * 1_000,
    })
  }
  const portable = await import('../../src/utils/sessionStoragePortable.ts')
  const dir = join(
    portable.getProjectDir(process.cwd()),
    'cache-clock',
    'sessions',
  )
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  check(
    'nothing was written inside the checkout (the UN-11 invariant)',
    !((): boolean => {
      try {
        readdirSync(join(process.cwd(), '.mercury', 'cache-clock'))
        return true
      } catch {
        return false
      }
    })(),
  )
  check(
    'no nested absolute-path tree under the projects home (projects/Users, projects/private, …)',
    !existsSync(join(portable.getProjectsDir(), portable.getProjectDir(process.cwd()), 'cache-clock')),
  )
  check('rollup file written (atomic, per-session)', files.length === 1, `found ${files.length}`)
  const rollup = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'))
  check(
    'rollup shape: v1, initial 5m decision + escalation recorded, gap counted once',
    rollup.v === 1 && rollup.decidedTtl === '5m' &&
      typeof rollup.escalatedAtIso === 'string' && rollup.gapsOver5m === 1,
    JSON.stringify({ decidedTtl: rollup.decidedTtl, gapsOver5m: rollup.gapsOver5m }),
  )
  check(
    'meter recorded both sides of the counterfactual',
    rollup.costUnits.actual > 0 && rollup.costUnits.baseline5m > 0,
  )
  check(
    'escalated session attributes creation writes to 1h in the meter',
    rollup.tokens.w1h > 0,
  )
}

section('§3b STORE KEYING — a worktree lane meters to its ORIGIN project (L24)')
{
  const { restoreWorktreeSession } = await import('../../src/utils/worktree.ts')
  const { mkdirSync: mkd } = await import('node:fs')
  const origin = join(mkdtempSync(join(tmpdir(), 'cache-clock proof origin-')), 'projected work')
  mkd(origin, { recursive: true })
  const lane = mkdtempSync(join(tmpdir(), 'cache-clock-proof-lane-'))
  restoreWorktreeSession({
    originalCwd: origin,
    worktreePath: lane,
    worktreeName: 'proof-lane',
    sessionId: 'proof-session',
  })
  resetCacheClockForTesting()
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: NOW })
  for (let i = 0; i < 3; i++) {
    cacheClockObserve({
      cacheReadTokens: 10, cacheCreationTotal: 1,
      cacheCreation5m: 1, cacheCreation1h: 0,
      uncachedInputTokens: 1, now: NOW + i,
    })
  }
  restoreWorktreeSession(null)
  const portable = await import('../../src/utils/sessionStoragePortable.ts')
  const originStore = join(
    portable.getProjectDir(origin),
    'cache-clock',
    'sessions',
  )
  check(
    'lane session rolls up under the ORIGIN project key',
    readdirSync(originStore).some(f => f.endsWith('.json')),
    originStore,
  )
  check(
    'the origin project key nests no absolute-path tree under the projects home',
    !existsSync(join(portable.getProjectsDir(), portable.getProjectDir(origin), 'cache-clock')),
  )
  check(
    'the lane checkout stays byte-clean',
    !((): boolean => {
      try {
        readdirSync(join(lane, '.mercury'))
        return true
      } catch {
        return false
      }
    })(),
  )
}

section('§5 RELAUNCH — the 1h tier a process bought survives a restart of the same session while the hour lasts')
{
  const { noteCacheClockPrefix } = shell
  const { tierLeaseOf, tierLeaseWarm } = core
  const portable = await import('../../src/utils/sessionStoragePortable.ts')
  const { getSessionId } = await import('../../src/bootstrap/state.ts')
  const dir = join(portable.getProjectDir(process.cwd()), 'cache-clock', 'sessions')
  const own = join(dir, `${String(getSessionId())}.json`)
  const PREFIX = 'owner|first-row|claude-fable-5-1'
  const T0 = NOW + 24 * 60 * 60_000
  const touch = (at: number, prefixKey: string | null = PREFIX): void =>
    cacheClockObserve({ cacheReadTokens: 400_000, cacheCreationTotal: 2_000, cacheCreation5m: null, cacheCreation1h: null, uncachedInputTokens: 50, now: at + 4_000, prefixKey, startedAt: at })

  resetCacheClockForTesting()
  noteCacheClockPrefix(PREFIX)
  check('process 1 starts on the 5m tier (thin prior, headless proof run)', cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: T0 }) === '5m')
  touch(T0)
  const escalatedAt = T0 + 12 * 60_000
  check('process 1 escalates to 1h after a 12-minute gap', cacheClockTtlDecision({ eligible: true, lastCompletionAt: T0 + 4_000, now: escalatedAt }) === '1h')
  touch(escalatedAt)
  const lastHeld = escalatedAt + 3 * 60_000
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: escalatedAt + 4_000, now: lastHeld })
  touch(lastHeld)
  const rollup1 = JSON.parse(readFileSync(own, 'utf8')) as { tier?: unknown; decidedTtl?: string; escalatedAtIso?: string }
  const lease1 = tierLeaseOf(rollup1)
  check('the rollup beside the session records the tier lease: 1h, held at the start of the last 1h request, for this prefix, since the escalation', lease1 !== null && lease1.heldAtIso === new Date(lastHeld).toISOString() && lease1.prefixKey === PREFIX && lease1.sinceIso === new Date(escalatedAt).toISOString() && rollup1.decidedTtl === '5m', JSON.stringify(rollup1.tier))
  check('a touch within the minute does not rewrite the file; the file still names the earlier hold', (() => {
    cacheClockTtlDecision({ eligible: true, lastCompletionAt: lastHeld + 4_000, now: lastHeld + 20_000 })
    touch(lastHeld + 20_000)
    const again = tierLeaseOf(JSON.parse(readFileSync(own, 'utf8')) as unknown)
    return again?.heldAtIso === new Date(lastHeld).toISOString()
  })())
  check('the pure warmth rule: warm up to the hour, cold past it, cold for another prefix', tierLeaseWarm(lease1, PREFIX, lastHeld + TTL_MS['1h']) && !tierLeaseWarm(lease1, PREFIX, lastHeld + TTL_MS['1h'] + 1) && !tierLeaseWarm(lease1, 'owner|first-row|claude-opus-5-5', lastHeld + 60_000) && !tierLeaseWarm(null, PREFIX, lastHeld))

  resetCacheClockForTesting()
  noteCacheClockPrefix(PREFIX)
  const relaunch20 = lastHeld + 20 * 60_000
  check("process 2, relaunched 20 minutes after the last 1h request on the same prefix, sends '1h' from its first request (no fresh 5m decision, no new escalation wait)", cacheClockTtlDecision({ eligible: true, lastCompletionAt: lastHeld + 4_000, now: relaunch20 }) === '1h')
  check('the snapshot shows the carried tier as an escalation already in force', cacheClockSnapshot().ttl === '1h' && cacheClockSnapshot().escalated)
  touch(relaunch20)
  const lease2 = tierLeaseOf(JSON.parse(readFileSync(own, 'utf8')) as unknown)
  check('process 2 refreshes the lease: held at its own request, since the original escalation', lease2?.heldAtIso === new Date(relaunch20).toISOString() && lease2.sinceIso === new Date(escalatedAt).toISOString(), JSON.stringify(lease2))

  resetCacheClockForTesting()
  noteCacheClockPrefix(PREFIX)
  const relaunch70 = relaunch20 + 70 * 60_000
  check("process 3, relaunched 70 minutes after the last 1h request, starts cold by the rule ('5m' with escalation)", cacheClockTtlDecision({ eligible: true, lastCompletionAt: relaunch20 + 4_000, now: relaunch70 }) === '5m' && !cacheClockSnapshot().escalated)
  touch(relaunch70)
  touch(relaunch70 + 10_000)
  touch(relaunch70 + 20_000)
  check('a 5m process holds no tier lease: its third observation flushes the rollup and the stale 1h lease leaves it', tierLeaseOf(JSON.parse(readFileSync(own, 'utf8')) as unknown) === null)

  resetCacheClockForTesting()
  noteCacheClockPrefix(PREFIX)
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: relaunch70 + 60_000 })
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: relaunch70 + 60_000, now: relaunch70 + 10 * 60_000 })
  touch(relaunch70 + 10 * 60_000)
  resetCacheClockForTesting()
  noteCacheClockPrefix('owner|first-row|claude-opus-5-5')
  check('a relaunch on another model (another prefix key) within the hour starts cold by the rule: the lease names the prefix it was bought for', cacheClockTtlDecision({ eligible: true, lastCompletionAt: relaunch70 + 10 * 60_000, now: relaunch70 + 15 * 60_000 }) === '5m')

  resetCacheClockForTesting()
  noteCacheClockPrefix(PREFIX)
  check('a warm lease never overrides an ineligible seat (no claude.ai sign-in, no pin)', cacheClockTtlDecision({ eligible: false, ineligible: 'console key', lastCompletionAt: relaunch70 + 10 * 60_000, now: relaunch70 + 15 * 60_000 }) === null)

  process.env.MERCURY_CACHE_TTL = '5m'
  resetCacheClockForTesting()
  noteCacheClockPrefix(PREFIX)
  check("an operator pin '5m' wins over a warm lease", cacheClockTtlDecision({ eligible: true, lastCompletionAt: relaunch70 + 10 * 60_000, now: relaunch70 + 15 * 60_000 }) === '5m')
  delete process.env.MERCURY_CACHE_TTL

  resetCacheClockForTesting()
  check('a side query that decides before the main prefix is known does not spend the lease: the first main-prefix request still consults it', (() => {
    const side = cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: relaunch70 + 16 * 60_000 })
    noteCacheClockPrefix(PREFIX)
    const main = cacheClockTtlDecision({ eligible: true, lastCompletionAt: relaunch70 + 10 * 60_000, now: relaunch70 + 16 * 60_000 })
    return side === '5m' && main === '1h'
  })())
  check('junk in the tier field is read as no lease', tierLeaseOf({ tier: { ttl: '5m', heldAtIso: 'x', prefixKey: 'p' } }) === null && tierLeaseOf({ tier: 'nope' }) === null && tierLeaseOf(null) === null && tierLeaseOf({ tier: { ttl: '1h', heldAtIso: 'not-a-date', prefixKey: 'p' } }) === null)
}

section('§4 SEAMS — structural wiring')
{
const anthropicRuntime = readFileSync(join(repoRoot, 'src/services/providers/anthropic/index.ts'), 'utf8') + readdirSync(join(repoRoot, 'src/services/providers/anthropic')).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(repoRoot, 'src/services/providers/anthropic', f), 'utf8')).join('\n')
  const decisionIdx = anthropicRuntime.indexOf('cacheClockTtlDecision({')
  const allowlistIdx = anthropicRuntime.indexOf("'mercury_prompt_cache_1h_config'")
  check('the anthropic runtime consults the clock', decisionIdx > 0)
  check(
    'the clock verdict is the whole decision (no remote allowlist path remains)',
    decisionIdx > 0 && allowlistIdx === -1,
  )
  check('the anthropic runtime taps the meter (cacheClockObserve)', anthropicRuntime.includes('cacheClockObserve({'))

  const shellSrc = readFileSync(join(repoRoot, 'src/utils/cache/cacheClock.ts'), 'utf8')
  check(
    'shell gate: MERCURY_CACHE_CLOCK ≠ 0 (live alias read; unconditional)',
    shellSrc.includes("flagEnabled('MERCURY_CACHE_CLOCK')"),
  )
  check(
    'decision path is fail-open (catch ⇒ logError ⇒ null)',
    /catch \(e: unknown\) \{\s*logError\(e\)\s*return null/.test(shellSrc),
  )

  const cost = readFileSync(join(repoRoot, 'src/utils/modelCost.ts'), 'utf8')
  check(
    'modelCost prices 1h cache writes at 2× input when the split is present',
    cost.includes('ephemeral_1h_input_tokens') && cost.includes('modelCosts.inputTokens * 2'),
  )
}

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ cache clock proof: all checks pass')
