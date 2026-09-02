import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isMercurySubstrateProfileOn } from '../../utils/config/derived.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

/**
 * Config resolution for the time-gap microcompact trigger.
 *
 * Defaults: disabled; gap threshold 60 minutes (the server's 1-hour cache
 * TTL is guaranteed expired for all accounts at that point, so the trigger
 * never forces a miss that would not have happened anyway); keep-recent 5.
 */
export type TimeBasedMCConfig = {
  enabled: boolean
  thresholdMinutes: number
  keepRecent: number
}

const DEFAULT_THRESHOLD_MINUTES = 60
const DEFAULT_KEEP_RECENT = 5

/** Adopt a remote number only when it is a finite number greater than zero. */
function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function getTimeBasedMCConfig(): TimeBasedMCConfig {
  // Read the gate key unconditionally so the exposure fires on every
  // evaluation path rather than only when the caller's other conditions pass.
  const remote = getDynamicConfig_CACHED_MAY_BE_STALE<{
    enabled?: unknown
    thresholdMinutes?: unknown
    keepRecent?: unknown
  }>('mercury_slate_heron', {})

  // Defensive per-field validation: a stale cache can return wrong types.
  const resolved: TimeBasedMCConfig = {
    enabled: remote?.enabled === true,
    thresholdMinutes: positiveNumber(remote?.thresholdMinutes, DEFAULT_THRESHOLD_MINUTES),
    keepRecent: positiveNumber(remote?.keepRecent, DEFAULT_KEEP_RECENT),
  }

  // Mercury override, additive-only: the trigger clears OLD tool results once
  // the server cache is already cold, so forcing it on never costs a cache
  // hit. Env is read live on every call — never latched at import.
  if (
    !resolved.enabled &&
    (isEnvTruthy(flagEnv('MERCURY_TIME_BASED_MC')) || isMercurySubstrateProfileOn())
  ) {
    return { ...resolved, enabled: true }
  }
  return resolved
}
