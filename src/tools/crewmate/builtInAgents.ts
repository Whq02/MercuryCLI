import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getIsNonInteractiveSession } from '../../boot/process-state/processState.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import { MERCURY_CREW_AGENT } from './built-in/mercuryCrewAgent.js'
import { MERCURY_SCOUT_AGENT } from './built-in/mercuryScoutAgent.js'

export function getBuiltInAgents(): AgentDefinition[] {
  if (
    isEnvTruthy(flagEnv('MERCURY_HOST_DISABLE_BUILTIN_AGENTS')) &&
    getIsNonInteractiveSession()
  ) {
    return []
  }
  return [MERCURY_CREW_AGENT, MERCURY_SCOUT_AGENT]
}
