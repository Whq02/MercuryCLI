
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
  sessionsDir: string
  cls: CacheClockClass
  startedIso: string
  escalatedAtIso: string | null
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

function resolveClass(): CacheClockClass {
  const e = process.env
  const worker =
    e.MERCURY_IMPLEMENTER === '1' ||
    (e.MERCURY_CREW_AGENT ?? '') !== '' ||
    (e.MERCURY_DAEMON_PERMISSION_MODE ?? '') !== ''
  if (worker) return 'worker'
  return getIsNonInteractiveSession() ? 'headless' : 'interactive'
}

function sessionsDir(): string {
  const identity = getCurrentWorktreeSession()?.originalCwd ?? getOriginalCwd()
  return join(getProjectsDir(), getProjectDir(identity), 'cache-clock', 'sessions')
}

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
      }
    }
  } catch {
  }
}

const ROLLUP_FLUSH_ESCALATION_STREAK = 3
let rollupFailureStreak = 0
let lastRollupFailure: { at: number; message: string } | null = null
let lastRollupOkAt: number | null = null
let rollupTeardownRegistered = false

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
      enabled: true,
      pin: resolvePin(),
      eligible,
      cls: clock.cls,
      prior: readPrior(clock.sessionsDir),
    })
    reapOldRollups(clock.sessionsDir)
    if (!rollupTeardownRegistered) {
      rollupTeardownRegistered = true
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
    if (state.requests === 3 || state.observesSinceFlush >= ROLLUP_FLUSH_EVERY) {
      state.observesSinceFlush = 0
      flushRollup(state)
    }
  } catch (e: unknown) {
    logError(e)
  }
}

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

export function resetCacheClockForTesting(): void {
  clock = null
  rollupFailureStreak = 0
  lastRollupFailure = null
  lastRollupOkAt = null
}
