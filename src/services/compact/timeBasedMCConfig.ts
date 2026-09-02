import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isMercurySubstrateProfileOn } from '../../utils/config/derived.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export type TimeBasedMCConfig = {
  enabled: boolean
  thresholdMinutes: number
  keepRecent: number
}

const DEFAULT_THRESHOLD_MINUTES = 60
const DEFAULT_KEEP_RECENT = 5

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function getTimeBasedMCConfig(): TimeBasedMCConfig {
  const remote = getDynamicConfig_CACHED_MAY_BE_STALE<{
    enabled?: unknown
    thresholdMinutes?: unknown
    keepRecent?: unknown
  }>('mercury_slate_heron', {})

  const resolved: TimeBasedMCConfig = {
    enabled: remote?.enabled === true,
    thresholdMinutes: positiveNumber(remote?.thresholdMinutes, DEFAULT_THRESHOLD_MINUTES),
    keepRecent: positiveNumber(remote?.keepRecent, DEFAULT_KEEP_RECENT),
  }

  if (
    !resolved.enabled &&
    (isEnvTruthy(flagEnv('MERCURY_TIME_BASED_MC')) || isMercurySubstrateProfileOn())
  ) {
    return { ...resolved, enabled: true }
  }
  return resolved
}
