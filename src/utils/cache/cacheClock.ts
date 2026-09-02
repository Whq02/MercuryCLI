/**
 * cacheClock — the Cache Clock's impure shell.
 *
 * Owns everything the pure core (cacheClockCore.ts) must not touch: env/flag
 * reads, the per-process latch, the (5m,1h]-cold-boundary escalation, the
 * cadence-prior scan, the live counterfactual meter, and the session rollup
 * persisted under the config home's per-project store
 * (projects/<key>/cache-clock/sessions).
 *
 * Contracts (proof-locked in scripts/cache/prove-cache-clock.ts):
 *  - OFF (MERCURY_CACHE_CLOCK=0) ⇒ cacheClockTtlDecision() is null
 *    before touching anything — the base should1hCacheTTL path runs
 *    byte-identically.
 *  - FAIL-OPEN: any disk/parse/clock fault degrades to null (the default 5m), never
 *    to a throw on the request path.
 *  - TTL-FLIP-AT-COLD-ONLY + SESSION-UNIFORM: one latch per process; the only
 *    legal mutation is the one-way 5m→1h escalation the core sanctions.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getIsNonInteractiveSession, getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { getProjectDir, getProjectsDir } from '../sessionStoragePortable.js'
import { getCurrentWorktreeSession } from '../worktree.js'
import { logError } from '../log.js'
import { logForDebugging } from '../debug.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  type CacheClockClass,
  type CadencePrior,
  type Decision,
  type SessionRollup,
  type SimCacheState,
  type TtlChoice,
  CACHE_COST,
  classifyGap,
  decideInitialTtl,
  newSimCacheState,
  priorFromRollups,
  shouldEscalate,
  stepCache,
} from './cacheClockCore.js'

const ROLLUP_FLUSH_EVERY = 8
const ROLLUP_KEEP_FILES = 200
const PRIOR_SCAN_LIMIT = 100

interface ClockState {
  initialized: boolean
  decision: Decision | null
  /** Pinned at latch time so read/flush/reap agree even if cwd moves later. */
  sessionsDir: string
  cls: CacheClockClass
  startedIso: string
  escalatedAtIso: string | null
  /** Dedupe basis: gaps/escalation are evaluated once per completed request. */
  lastGapBasis: number | null
  requests: number
  gapsOver5m: number
  gapsOver1h: number
  tokens: { read: number; w5m: number; w1h: number; uncached: number }
  costActual: number
  costBaseline: number
  baseline: SimCacheState
  observesSinceFlush: number
}

let clock: ClockState | null = null

function freshState(): ClockState {
  return {
    initialized: false,
    decision: null,
    sessionsDir: '',
    cls: 'interactive',
    startedIso: new Date().toISOString(),
    escalatedAtIso: null,
    lastGapBasis: null,
    requests: 0,
    gapsOver5m: 0,
    gapsOver1h: 0,
    tokens: { read: 0, w5m: 0, w1h: 0, uncached: 0 },
    costActual: 0,
    costBaseline: 0,
    baseline: newSimCacheState('5m'),
    observesSinceFlush: 0,
  }
}

function clockEnabled(): boolean {
  return flagEnv('MERCURY_CACHE_CLOCK') !== '0'
}

function resolvePin(): TtlChoice | null {
  const raw = (flagEnv('MERCURY_CACHE_TTL') ?? '').trim().toLowerCase()
  return raw === '5m' || raw === '1h' ? raw : null
}

/**
 * Daemon-spawned workers (Implementer, crew teammates) idle by
 * design between dispatches — decision-table row 4. Role markers are stamped
 * by the daemon spawn paths (crewSpawn/longLivedSupervisor).
 */
function resolveClass(): CacheClockClass {
  const e = process.env
  const worker =
    e.MERCURY_IMPLEMENTER === '1' ||
    (e.MERCURY_CREW_AGENT ?? '') !== '' ||
    (e.MERCURY_DAEMON_PERMISSION_MODE ?? '') !== ''
  if (worker) return 'worker'
  return getIsNonInteractiveSession() ? 'headless' : 'interactive'
}

/** rollups are Mercury RUNTIME BOOKKEEPING — they live in
 *  the global per-project store (projects/<key>/cache-clock/sessions), keyed
 *  to the ORIGINAL project identity through the ONE shared key derivation
 *  (getProjectDir: canonicalize + sanitizePath — a pinned fixture law),
 *  never inside the checkout at cwd. A
 *  cwd-adopted location would plant an untracked file inside isolated
 *  worktree lanes — a pristine-authored lane reads dirty and settlement
 *  blocks — and would latch whichever lane's
 *  request came first as the store for the whole process. A worktree
 *  session keys to its ORIGIN project — its metering belongs to that
 *  project's cadence prior. */
function sessionsDir(): string {
  const identity = getCurrentWorktreeSession()?.originalCwd ?? getOriginalCwd()
  return join(getProjectsDir(), getProjectDir(identity), 'cache-clock', 'sessions')
}

/** Scan the newest rollups for the cadence prior. Junk-tolerant, fail-open. */
function readPrior(dir: string): CadencePrior {
  try {
    const own = `${getSessionId()}.json`
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.json') && f !== own)
      .map(f => {
        const p = join(dir, f)
        try {
          return { p, mtime: statSync(p).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((x): x is { p: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, PRIOR_SCAN_LIMIT)
    const rollups = files.map(({ p }) => {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as unknown
      } catch {
        return null
      }
    })
    return priorFromRollups(rollups)
  } catch {
    return { sessions: 0, gapSessions: 0 }
  }
}

/** Best-effort housekeeping: keep the newest ROLLUP_KEEP_FILES rollups. */
function reapOldRollups(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const p = join(dir, f)
        try {
          return { p, mtime: statSync(p).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((x): x is { p: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
    for (const { p } of files.slice(ROLLUP_KEEP_FILES)) {
      try {
        unlinkSync(p)
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

/* K7 flush-death law: the rollup is a whole-state snapshot, so a
   failed write loses nothing (memory IS the buffer and the next flush
   rewrites it) — but consecutive failures must never be invisible
   (the bare fail-open catch class). They count a streak with an error-level log at
   the escalation mark, /doctor's cache-clock probe reads this health, and
   teardown makes one final attempt + one honest notice. */
const ROLLUP_FLUSH_ESCALATION_STREAK = 3
let rollupFailureStreak = 0
let lastRollupFailure: { at: number; message: string } | null = null
let lastRollupOkAt: number | null = null
let rollupTeardownRegistered = false

/** Live flush health for /doctor's cache-clock probe. */
export function getCacheClockFlushHealth(): {
  streak: number
  lastFailure: { at: number; message: string } | null
  lastRollupOkAt: number | null
} {
  return {
    streak: rollupFailureStreak,
    lastFailure: lastRollupFailure,
    lastRollupOkAt: lastRollupOkAt,
  }
}

/** Drive one rollup flush on the live clock (the prover's deterministic
 *  seam + the teardown attempt). No-op when the clock never latched. */
export function flushCacheClockNow(): void {
  if (clock !== null && clock.initialized) flushRollup(clock)
}

function flushRollup(state: ClockState): void {
  if (state.decision === null) return
  try {
    const dir = state.sessionsDir
    if (dir === '') return
    mkdirSync(dir, { recursive: true })
    const rollup: SessionRollup = {
      v: 1,
      sessionId: String(getSessionId()),
      cls: state.cls,
      startedIso: state.startedIso,
      decidedTtl: state.escalatedAtIso !== null ? '5m' : state.decision.ttl,
      ...(state.escalatedAtIso !== null && {
        escalatedAtIso: state.escalatedAtIso,
      }),
      requests: state.requests,
      gapsOver5m: state.gapsOver5m,
      gapsOver1h: state.gapsOver1h,
      tokens: { ...state.tokens },
      costUnits: {
        actual: Math.round(state.costActual),
        baseline5m: Math.round(state.costBaseline),
      },
      updatedIso: new Date().toISOString(),
    }
    durableAtomicPublishSync(
      join(dir, `${rollup.sessionId}.json`),
      JSON.stringify(rollup, null, 1),
    )
    rollupFailureStreak = 0
    lastRollupFailure = null
    lastRollupOkAt = Date.now()
  } catch (error) {
    // FAIL-OPEN: metering must never disturb the request path — but the
    // failure is COUNTED, escalated at the mark, and visible to /doctor.
    rollupFailureStreak++
    lastRollupFailure = { at: Date.now(), message: String(error) }
    logForDebugging(
      `Failed to write cache-clock rollup (streak ${rollupFailureStreak}): ${error}`,
      rollupFailureStreak >= ROLLUP_FLUSH_ESCALATION_STREAK
        ? { level: 'error' }
        : undefined,
    )
  }
}

function ensureLatch(eligible: boolean): ClockState {
  if (clock === null) clock = freshState()
  if (!clock.initialized) {
    clock.initialized = true
    clock.sessionsDir = sessionsDir()
    clock.cls = resolveClass()
    clock.decision = decideInitialTtl({
      enabled: true, // clockEnabled() checked by the caller
      pin: resolvePin(),
      eligible,
      cls: clock.cls,
      prior: readPrior(clock.sessionsDir),
    })
    reapOldRollups(clock.sessionsDir)
    if (!rollupTeardownRegistered) {
      rollupTeardownRegistered = true
      // one final rollup attempt at teardown (a session shorter than
      // the flush cadence still lands its rollup) + ONE honest notice when
      // the last state never reached disk.
      registerCleanup(async () => {
        flushCacheClockNow()
        if (rollupFailureStreak > 0) {
          logForDebugging(
            `[cache-clock] teardown: session rollup unflushed (streak ${rollupFailureStreak}): ${lastRollupFailure?.message ?? 'unknown'}`,
            { level: 'error' },
          )
        }
      })
    }
  }
  return clock
}

/**
 * Per-request gap accounting + the sanctioned escalation, deduped on the
 * lastCompletionAt basis (getCacheControl runs several times per request —
 * system blocks, message marker, tools — this must count once).
 */
function accountGap(
  state: ClockState,
  lastCompletionAt: number | null,
  now: number,
): void {
  if (lastCompletionAt === null || lastCompletionAt === state.lastGapBasis)
    return
  state.lastGapBasis = lastCompletionAt
  const gapMs = now - lastCompletionAt
  const kind = classifyGap(gapMs)
  if (kind === 'over5m') state.gapsOver5m++
  if (kind === 'over1h') state.gapsOver1h++
  if (state.decision !== null && shouldEscalate(state.decision, gapMs)) {
    state.decision = { ttl: '1h', escalation: false }
    state.escalatedAtIso = new Date().toISOString()
    flushRollup(state)
  }
}

/**
 * The TTL verdict consulted by should1hCacheTTL (services/providers/anthropic/index.ts).
 * null ⇒ the clock is not engaged; the default path runs byte-identically.
 */
export function cacheClockTtlDecision(args: {
  eligible: boolean
  lastCompletionAt: number | null
  now: number
}): TtlChoice | null {
  try {
    if (!clockEnabled()) return null
    const state = ensureLatch(args.eligible)
    accountGap(state, args.lastCompletionAt, args.now)
    return state.decision === null ? null : state.decision.ttl
  } catch (e: unknown) {
    logError(e)
    return null
  }
}

/**
 * Post-response meter tap (shape-only). Feeds the session rollup and runs the
 * all-5m shadow baseline so every live session records its own counterfactual
 * (the state store + counterfactual meter).
 */
export function cacheClockObserve(args: {
  cacheReadTokens: number
  cacheCreationTotal: number
  cacheCreation5m: number | null
  cacheCreation1h: number | null
  uncachedInputTokens: number
  now: number
}): void {
  try {
    if (!clockEnabled()) return
    if (clock === null || !clock.initialized || clock.decision === null) return
    const state = clock
    const decidedTtl = clock.decision.ttl
    state.requests++

    const w1h =
      args.cacheCreation1h ?? (decidedTtl === '1h' ? args.cacheCreationTotal : 0)
    const w5m =
      args.cacheCreation5m ?? (decidedTtl === '1h' ? 0 : args.cacheCreationTotal)
    state.tokens.read += args.cacheReadTokens
    state.tokens.w5m += w5m
    state.tokens.w1h += w1h
    state.tokens.uncached += args.uncachedInputTokens

    state.costActual +=
      args.cacheReadTokens * CACHE_COST.read +
      w5m * CACHE_COST.write5m +
      w1h * CACHE_COST.write1h +
      args.uncachedInputTokens * CACHE_COST.uncached

    const promptTokens =
      args.cacheReadTokens + args.cacheCreationTotal + args.uncachedInputTokens
    const base = stepCache(state.baseline, args.now, promptTokens)
    state.costBaseline +=
      base.costUnits + args.uncachedInputTokens * CACHE_COST.uncached

    state.observesSinceFlush++
    // Flush early once a session is real (3 requests) so short sessions are
    // visible to the cadence prior, then on a steady cadence.
    if (state.requests === 3 || state.observesSinceFlush >= ROLLUP_FLUSH_EVERY) {
      state.observesSinceFlush = 0
      flushRollup(state)
    }
  } catch (e: unknown) {
    logError(e)
  }
}

/** Introspection for the doctor/proof surface: the latched verdict, if any. */
export function cacheClockSnapshot(): {
  engaged: boolean
  ttl: TtlChoice | null
  cls: CacheClockClass | null
  escalated: boolean
} {
  if (!clockEnabled() || clock === null || !clock.initialized) {
    return { engaged: false, ttl: null, cls: null, escalated: false }
  }
  return {
    engaged: clock.decision !== null,
    ttl: clock.decision?.ttl ?? null,
    cls: clock.cls,
    escalated: clock.escalatedAtIso !== null,
  }
}

/** Test seam: reset the per-process latch (proofs only). */
export function resetCacheClockForTesting(): void {
  clock = null
  rollupFailureStreak = 0
  lastRollupFailure = null
  lastRollupOkAt = null
}
