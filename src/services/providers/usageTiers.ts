export const FIRST_WARNING_PCT = 80
export const SECOND_WARNING_PCT = 90
export const APPROACHING_LIMIT_PCT = FIRST_WARNING_PCT
export type UsageWarningTier = typeof FIRST_WARNING_PCT | typeof SECOND_WARNING_PCT

export function usageWarningTier(pct: number | undefined): UsageWarningTier | null {
  if (pct === undefined || !Number.isFinite(pct) || pct < FIRST_WARNING_PCT) return null
  return pct >= SECOND_WARNING_PCT ? SECOND_WARNING_PCT : FIRST_WARNING_PCT
}

export function usageWindowState(pct: number | undefined): 'allowed' | 'warning' | 'rejected' {
  return usageWarningTier(pct) === null ? 'allowed' : 'warning'
}
