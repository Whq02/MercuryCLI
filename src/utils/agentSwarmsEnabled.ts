import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { isEnvTruthy } from './envUtils.js'


const TEAMS_KILLSWITCH_GATE = 'mercury_amber_flint'

export function isAgentSwarmsEnabled(): boolean {
  if (flagEnv('MERCURY_SWARMS') !== '0') return true

  const optedIn = process.argv.includes('--agent-teams')
  if (!optedIn) return false

  return getFeatureValue_CACHED_MAY_BE_STALE(TEAMS_KILLSWITCH_GATE, true)
}
