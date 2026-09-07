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

export function getTimeBasedMCConfig(): TimeBasedMCConfig {
  return {
    enabled: isEnvTruthy(flagEnv('MERCURY_TIME_BASED_MC')) || isMercurySubstrateProfileOn(),
    thresholdMinutes: DEFAULT_THRESHOLD_MINUTES,
    keepRecent: DEFAULT_KEEP_RECENT,
  }
}
