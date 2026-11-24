
const FOLD_DEFAULTS = Object.freeze({
  thresholdPct: 85,
  cooldownTurns: 8,
  rearmBelowPct: 55,
})

const MAX_CONSECUTIVE_AUTO_FOLD_FAILURES = 3

interface FoldPolicy {
  thresholdPct?: number
  cooldownTurns?: number
  rearmBelowPct?: number
}

export interface FoldPolicyState {
  lastFiredTurn?: number | null
  rearmed?: boolean
}

interface DecideFoldInput {
  usage?: { percentage?: number } | null
  state?: FoldPolicyState | null
  turn?: number
  policy?: FoldPolicy
}

interface DecideFoldResult {
  action: 'none' | 'compact'
  reason: string
  state: { lastFiredTurn: number | null; rearmed: boolean }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function decideFold(
  input: DecideFoldInput,
): DecideFoldResult {
  const i = input && typeof input === 'object' ? input : {}
  const pol = {
    ...FOLD_DEFAULTS,
    ...(i.policy && typeof i.policy === 'object' ? i.policy : {}),
  }
  const st = i.state && typeof i.state === 'object' ? i.state : {}
  const lastFiredTurn = isFiniteNumber(st.lastFiredTurn) ? st.lastFiredTurn : null
  const rearmed = st.rearmed !== false
  const turn = isFiniteNumber(i.turn) ? i.turn : null
  const pct =
    i.usage && typeof i.usage === 'object' && isFiniteNumber(i.usage.percentage)
      ? i.usage.percentage
      : null

  const keep = (
    reason: string,
    nextRearmed: boolean = rearmed,
  ): DecideFoldResult => ({
    action: 'none',
    reason,
    state: { lastFiredTurn, rearmed: nextRearmed },
  })

  if (pct === null) return keep('no usage signal (fail-closed)')
  if (turn === null) return keep('no turn counter (fail-closed)')

  const nowRearmed = rearmed || pct < pol.rearmBelowPct
  if (pct < pol.thresholdPct) {
    return keep(
      `fill ${pct}% below threshold ${pol.thresholdPct}%`,
      nowRearmed,
    )
  }
  if (!nowRearmed) {
    return keep(
      `disarmed until fill dips below ${pol.rearmBelowPct}% (last fire bought no room yet)`,
      nowRearmed,
    )
  }
  if (lastFiredTurn !== null && turn - lastFiredTurn < pol.cooldownTurns) {
    return keep(
      `cooldown: fired at turn ${lastFiredTurn}, ${pol.cooldownTurns - (turn - lastFiredTurn)} turns left`,
      nowRearmed,
    )
  }
  return {
    action: 'compact',
    reason: `window fill ${pct}% >= ${pol.thresholdPct}% — advance compaction`,
    state: { lastFiredTurn: turn, rearmed: false },
  }
}

export function foldBreakerAllows(
  consecutiveFailures: number | undefined,
  limit: number = MAX_CONSECUTIVE_AUTO_FOLD_FAILURES,
): boolean {
  const cap =
    isFiniteNumber(limit) && limit > 0
      ? Math.floor(limit)
      : MAX_CONSECUTIVE_AUTO_FOLD_FAILURES
  if (!isFiniteNumber(consecutiveFailures)) return true
  return consecutiveFailures < cap
}

export function nextFoldFailureCount(
  prev: number | undefined,
  succeeded: boolean,
): number {
  const p =
    isFiniteNumber(prev) && prev > 0 ? Math.floor(prev) : 0
  return succeeded ? 0 : p + 1
}

export function percentUsedFromPercentLeft(percentLeft: number): number {
  if (!isFiniteNumber(percentLeft)) return 0
  return Math.min(100, Math.max(0, 100 - percentLeft))
}
