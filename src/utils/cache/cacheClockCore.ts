
export type TtlChoice = '5m' | '1h'
export type CacheClockClass = 'worker' | 'interactive' | 'headless'

export const TTL_MS: Record<TtlChoice, number> = {
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
}

export const CACHE_COST = {
  read: 0.1,
  write5m: 1.25,
  write1h: 2.0,
  uncached: 1.0,
} as const

export const PRIOR_GAP_SHARE_THRESHOLD = 0.4
export const PRIOR_MIN_SESSIONS = 3

export interface CadencePrior {
  sessions: number
  gapSessions: number
}

export interface DecisionInput {
  enabled: boolean
  pin: TtlChoice | null
  eligible: boolean
  cls: CacheClockClass
  prior: CadencePrior
}

export interface Decision {
  ttl: TtlChoice
  escalation: boolean
}

export function decideInitialTtl(i: DecisionInput): Decision | null {
  if (!i.enabled) return null
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

export function shouldEscalate(current: Decision, gapMs: number): boolean {
  return (
    current.escalation &&
    current.ttl === '5m' &&
    gapMs > TTL_MS['5m'] &&
    gapMs <= TTL_MS['1h']
  )
}

export function classifyGap(gapMs: number): 'none' | 'over5m' | 'over1h' {
  if (gapMs > TTL_MS['1h']) return 'over1h'
  if (gapMs > TTL_MS['5m']) return 'over5m'
  return 'none'
}


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
  costUnits: number
  coldRewrite: boolean
}

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
  costUnits: { actual: number; baseline5m: number }
  updatedIso: string
}

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
