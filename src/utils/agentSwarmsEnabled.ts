import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { isEnvTruthy } from './envUtils.js'

/**
 * The single gate answering "are agent teams / teammate features available
 * in this session?". Every prompt, tool enablement, UI branch, and code
 * path consults this — no parallel gate may be introduced.
 */

// Wire contract data (spec step 3): consulted only when the operator
// set MERCURY_SWARMS=0 AND an explicit opt-in is present; enabled when
// unreachable.
const TEAMS_KILLSWITCH_GATE = 'mercury_amber_flint'

export function isAgentSwarmsEnabled(): boolean {
  // Mercury policy: teammate chats are first-class product features, so
  // teams are on unless the registered flag is set to the string '0'. This
  // branch short-circuits — the external opt-in and the remote killswitch
  // do not apply, because risky capability is governed by the substrate's
  // own kill-switch rather than by this gate.
  if (flagEnv('MERCURY_SWARMS') !== '0') return true

  // External builds require an explicit opt-in: the command-line flag, read
  // directly off the process arguments (the bootstrap state would close an
  // import cycle here). The flag works for anyone who passes it, subject to
  // the killswitch. No env spelling exists.
  const optedIn = process.argv.includes('--agent-teams')
  if (!optedIn) return false

  // Remote killswitch, defaulting to enabled when unreachable.
  return getFeatureValue_CACHED_MAY_BE_STALE(TEAMS_KILLSWITCH_GATE, true)
}
