/**
 * cacheClockCore — the PURE decision + cost core of the Cache Clock
 *. ZERO imports by design: the proof suite
 * (scripts/cache/) and the benchmark simulator (scripts/cache/bench-sim.ts)
 * drive these exact functions, so the number in the committed verdict is
 * computed by the production policy, not a reimplementation.
 *
 * The impure shell (cacheClock.ts) owns env/config/disk; everything here is
 * deterministic on its arguments.
 */

export type TtlChoice = '5m' | '1h'
export type CacheClockClass = 'worker' | 'interactive' | 'headless'

export const TTL_MS: Record<TtlChoice, number> = {
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
}

/** API pricing multipliers (× base input price). */
export const CACHE_COST = {
  read: 0.1,
  write5m: 1.25,
  write1h: 2.0,
  uncached: 1.0,
} as const

/**
 * Prior threshold: share of sessions with a (5m,1h] gap above which upfront-1h
 * beats 5m+escalate in expectation. EV-neutral point ≈ 0.75/(1.15+0.75) ≈ 0.39
 * (a saved rewrite nets ~0.4×prefix; a wasted premium costs ~0.75×written).
 */
export const PRIOR_GAP_SHARE_THRESHOLD = 0.4
/** Below this many recorded sessions the prior is thin — stay conservative. */
export const PRIOR_MIN_SESSIONS = 3

export interface CadencePrior {
  /** Sessions with a recorded rollup. */
  sessions: number
  /** Of those, sessions that contained at least one (5m,1h] gap. */
  gapSessions: number
}

export interface DecisionInput {
  /** Fork build ∧ MERCURY_CACHE_CLOCK ≠ '0' ∧ not explicitly disabled. */
  enabled: boolean
  /** MERCURY_CACHE_TTL operator pin ('5m' | '1h'), validated by the shell. */
  pin: TtlChoice | null
  /** Provider 1h eligibility (claude.ai subscriber within limits). */
  eligible: boolean
  cls: CacheClockClass
  prior: CadencePrior
}

export interface Decision {
  ttl: TtlChoice
  /** May escalate 5m→1h at a cold boundary (rows 6–7 of the decision table). */
  escalation: boolean
}

/**
 * The decision table. Returns null when the clock is
 * not engaged — the caller falls through to the default path byte-identically.
 */
export function decideInitialTtl(i: DecisionInput): Decision | null {
  if (!i.enabled) return null
  // Operator pin wins over everything, including eligibility: an explicit
  // '1h' pin is the operator's own billing consent (2× write premium).
  if (i.pin !== null) return { ttl: i.pin, escalation: false }
  if (!i.eligible) return null
  if (i.cls === 'worker') return { ttl: '1h', escalation: false }
  if (
    i.cls === 'interactive' &&
    i.prior.sessions >= PRIOR_MIN_SESSIONS &&
    i.prior.gapSessions / i.prior.sessions >= PRIOR_GAP_SHARE_THRESHOLD
  ) {
    return { ttl: '1h', escalation: false }
  }
  return { ttl: '5m', escalation: true }
}

/**
 * TTL-FLIP-AT-COLD-ONLY: an escalation is legal only when the latched TTL is
 * 5m and the observed gap proves every 5m entry already expired — AND the gap
 * is one the 1h TTL would actually have survived ((5m, 1h]). Gaps beyond 1h
 * predict abandonment, not cadence; nothing to win there.
 */
export function shouldEscalate(current: Decision, gapMs: number): boolean {
  return (
    current.escalation &&
    current.ttl === '5m' &&
    gapMs > TTL_MS['5m'] &&
    gapMs <= TTL_MS['1h']
  )
}

/** Gap classification used for the cadence prior and the meter. */
export function classifyGap(gapMs: number): 'none' | 'over5m' | 'over1h' {
  if (gapMs > TTL_MS['1h']) return 'over1h'
  if (gapMs > TTL_MS['5m']) return 'over5m'
  return 'none'
}

// ---------------------------------------------------------------------------
// Shared cache state machine — used by the live counterfactual meter (shadow
// all-5m baseline) and by the benchmark simulator for BOTH policies.
// ---------------------------------------------------------------------------

export interface SimCacheState {
  prefixTokens: number
  lastUseAtMs: number | null
  ttl: TtlChoice
}

export function newSimCacheState(ttl: TtlChoice): SimCacheState {
  return { prefixTokens: 0, lastUseAtMs: null, ttl }
}

export interface SimStepResult {
  readTokens: number
  writtenTokens: number
  /** Input-token-equivalent cost units for the CACHE portion of the request. */
  costUnits: number
  /** True when a previously-warm prefix had expired (a paid full rewrite). */
  coldRewrite: boolean
}

/**
 * Advance the cache state machine by one request.
 *
 * Semantics modeled (verified against the current prompt-caching contract):
 * prefix caching with a sliding tail marker (prefix ≈ current prompt), TTL
 * expiry, refresh-on-use, per-TTL write premiums, full rewrite when cold.
 * A prompt that SHRINKS below 60% of the cached prefix is treated as a
 * content change (compaction/system edit) — a full miss for every policy.
 *
 * `writeTtl` models a TTL escalation happening AT this request: aliveness of
 * the existing entries is judged under the OLD ttl (they were written with
 * it), while the tokens written by this request carry — and are priced at —
 * the NEW ttl, which becomes the state's ttl going forward. Judging aliveness
 * under the new ttl would retroactively resurrect expired 5m entries, which
 * is exactly the accounting error the cold-boundary invariant exists to
 * forbid.
 */
export function stepCache(
  state: SimCacheState,
  atMs: number,
  promptTokens: number,
  writeTtl?: TtlChoice,
): SimStepResult {
  const hadPrefix = state.lastUseAtMs !== null && state.prefixTokens > 0
  const withinTtl =
    state.lastUseAtMs !== null && atMs - state.lastUseAtMs <= TTL_MS[state.ttl]
  const contentBust = hadPrefix && promptTokens < state.prefixTokens * 0.6
  const alive = hadPrefix && withinTtl && !contentBust

  const effectiveWriteTtl = writeTtl ?? state.ttl
  const readTokens = alive ? Math.min(state.prefixTokens, promptTokens) : 0
  const writtenTokens = Math.max(0, promptTokens - readTokens)
  const writeMult =
    effectiveWriteTtl === '1h' ? CACHE_COST.write1h : CACHE_COST.write5m

  const coldRewrite = hadPrefix && !withinTtl
  state.prefixTokens = promptTokens
  state.lastUseAtMs = atMs
  state.ttl = effectiveWriteTtl

  return {
    readTokens,
    writtenTokens,
    costUnits: readTokens * CACHE_COST.read + writtenTokens * writeMult,
    coldRewrite,
  }
}

// ---------------------------------------------------------------------------
// Session rollup shape — one file per process under the config home's
// per-project store (projects/<key>/cache-clock/sessions; shape-only:
// counts and timestamps, never content). The scan of these files IS the
// cadence prior.
// ---------------------------------------------------------------------------

export interface SessionRollup {
  v: 1
  sessionId: string
  cls: CacheClockClass
  startedIso: string
  decidedTtl: TtlChoice
  escalatedAtIso?: string
  requests: number
  gapsOver5m: number
  gapsOver1h: number
  tokens: { read: number; w5m: number; w1h: number; uncached: number }
  /** Input-token-equivalent units: what we paid vs the all-5m shadow baseline. */
  costUnits: { actual: number; baseline5m: number }
  updatedIso: string
}

/** Fold a directory of rollups into the cadence prior. Tolerates junk rows. */
export function priorFromRollups(rollups: unknown[]): CadencePrior {
  let sessions = 0
  let gapSessions = 0
  for (const r of rollups) {
    if (
      r !== null &&
      typeof r === 'object' &&
      (r as SessionRollup).v === 1 &&
      typeof (r as SessionRollup).requests === 'number' &&
      (r as SessionRollup).requests > 0
    ) {
      sessions++
      if (((r as SessionRollup).gapsOver5m ?? 0) > 0) gapSessions++
    }
  }
  return { sessions, gapSessions }
}
