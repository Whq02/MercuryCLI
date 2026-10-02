import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { MERCURY_CREW_AGENT } from './built-in/mercuryCrewAgent.js'
import { MERCURY_SCOUT_AGENT } from './built-in/mercuryScoutAgent.js'

export function getBuiltInAgents(): AgentDefinition[] {
  if (
    isEnvTruthy(process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return []
  }
  return [MERCURY_CREW_AGENT, MERCURY_SCOUT_AGENT]
}
