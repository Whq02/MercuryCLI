#!/usr/bin/env bun
// ============================================================================
//  scripts/cache/prove-cache-clock.ts
//  PROOF: the Cache Clock decision core + shell contracts
//   §1 CORE — the decision table, escalation predicate, gap classifier, the
//      cache state machine (incl. the writeTtl escalation semantics), and the
//      prior fold, driven as pure functions.
//   §2 INVARIANT — TTL-FLIP-AT-COLD-ONLY as a sequence property: replaying
//      gap sequences through the production transition never flips the TTL
//      unless the gap exceeded the previously latched TTL.
//   §3 SHELL — the real impure shell driven under stamp-sim (globalThis.MACRO
//      set pre-import) in a scratch cwd: OFF ⇒ null (default path), pin wins,
//      worker classing, live escalation, rollup persistence.
//   §4 SEAMS — structural: the claude.ts wiring, the fail-open catch, the
//      modelCost 1h split.
//  Run:  ~/.bun/bin/bun run scripts/cache/prove-cache-clock.ts
// ============================================================================
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
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

// Fork-sim + isolation BEFORE any src import: the build stamp reads the
// ambient MACRO global (a build define; undefined under source-run), and the
// shell persists rollups under getCwd()/.claude — run from a scratch cwd.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-hermes-proof' }
process.chdir(mkdtempSync(join(tmpdir(), 'cache-clock-proof-')))
// rollups live in the GLOBAL per-project store — pin the config
// home to scratch so the proof never touches this machine's real store (L26).
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cache-clock-proof-home-'))
// Both spellings scrubbed: resolveClass() reads the role markers via their
// RAW canonical spellings (cacheClock.ts), while the pin/kill flags resolve
// canonical-first through the registry — ambient state in either spelling
// would poison the classing legs.
for (const k of [
  'MERCURY_CACHE_CLOCK', 'MERCURY_CACHE_CLOCK',
  'MERCURY_CACHE_TTL', 'MERCURY_CACHE_TTL',
  'MERCURY_IMPLEMENTER', 'MERCURY_IMPLEMENTER',
  'MERCURY_TANK', 'MERCURY_TANK',
  'MERCURY_HEALER', 'MERCURY_HEALER',
  'MERCURY_CREW_AGENT', 'MERCURY_CREW_AGENT',
  'MERCURY_DAEMON_PERMISSION_MODE', 'MERCURY_DAEMON_PERMISSION_MODE',
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
  // writeTtl escalation semantics: aliveness judged under the OLD ttl, the
  // rewrite priced at the NEW ttl, state carries the new ttl forward.
  const s = newSimCacheState('5m')
  stepCache(s, 0, 1000)
  const at = TTL_MS['5m'] + 60_000 // 6-minute gap: 5m entries dead
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
  // Exhaustive over gap triples: replay the production transition and assert
  // any TTL change is justified by a gap larger than the PREVIOUS ttl.
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
    // Under bun the session is non-interactive ⇒ 'headless'; both non-worker
    // classes latch 5m+escalation here. Worker misclassification is the bug
    // class this guards.
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

// resolveClass() reads the role markers via their RAW canonical spellings
// (cacheClock.ts) — the daemon stamps every registered spelling (flagPair),
// so the canonical one is what this in-process drive must speak.
process.env.MERCURY_CREW_AGENT = 'proof-worker'
resetCacheClockForTesting()
check(
  "worker classing from daemon child env ⇒ upfront '1h'",
  cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: NOW }) === '1h' &&
    cacheClockSnapshot().cls === 'worker',
)
delete process.env.MERCURY_CREW_AGENT

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
  // the store is the GLOBAL projects home keyed by the
  // ONE shared derivation — never the checkout at cwd.
  const portable = await import('../../src/utils/sessionStoragePortable.ts')
  const dir = join(
    portable.getProjectsDir(),
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
  // The UN-11 class: a session running INSIDE an isolated worktree must not
  // key runtime bookkeeping to the lane. The origin path carries a SPACE —
  // the byte class the retired slug rule mishandled; the shared
  // getProjectDir derivation is the pin.
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
    portable.getProjectsDir(),
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

section('§4 SEAMS — structural wiring')
{
  // R6 module-scoped read
const claude = readFileSync(join(repoRoot, 'src/services/providers/anthropic/index.ts'), 'utf8') + readdirSync(join(repoRoot, 'src/services/providers/anthropic')).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(repoRoot, 'src/services/providers/anthropic', f), 'utf8')).join('\n')
  const decisionIdx = claude.indexOf('cacheClockTtlDecision({')
  const allowlistIdx = claude.indexOf("'mercury_prompt_cache_1h_config'")
  check('claude.ts consults the clock', decisionIdx > 0)
  check(
    'clock verdict precedes the (dead) remote-allowlist path',
    decisionIdx > 0 && allowlistIdx > decisionIdx,
  )
  check('claude.ts taps the meter (cacheClockObserve)', claude.includes('cacheClockObserve({'))

  const shellSrc = readFileSync(join(repoRoot, 'src/utils/cache/cacheClock.ts'), 'utf8')
  check(
    'shell gate: MERCURY_CACHE_CLOCK ≠ 0 (live alias read; unconditional)',
    shellSrc.includes("flagEnv('MERCURY_CACHE_CLOCK') !== '0'"),
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
