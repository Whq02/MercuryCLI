import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import { isMercurySubstrateProfileOn } from '../../platform/config/derived.js'

const DEFAULT_THRESHOLD_MINUTES = 60
const DEFAULT_KEEP_RECENT = 10

type TimeBasedMCConfig = {
  enabled: boolean
  thresholdMinutes: number
  keepRecent: number
}

export function getTimeBasedMCConfig(): TimeBasedMCConfig {
  return {
    enabled: isEnvTruthy(flagEnv('MERCURY_TIME_BASED_MC')) || isMercurySubstrateProfileOn(),
    thresholdMinutes: DEFAULT_THRESHOLD_MINUTES,
    keepRecent: DEFAULT_KEEP_RECENT,
  }
}
