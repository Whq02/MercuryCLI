
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { MERCURY_ARCHITECT_AGENT } from './built-in/mercuryArchitectAgent.js'
import { MERCURY_BACKGROUND_AGENT } from './built-in/mercuryBackgroundAgent.js'
import { MERCURY_GUIDE_AGENT, isGuideAgentMounted } from './built-in/mercuryGuideAgent.js'
import { MERCURY_SCOUT_AGENT } from './built-in/mercuryScoutAgent.js'
import { VERIFICATION_AGENT } from './built-in/verificationAgent.js'

export const LEGACY_SUBAGENT_ALIASES: Readonly<Record<string, string>> = {
  claude: 'mercury-background',
  Explore: 'mercury-scout',
  Plan: 'mercury-architect',
}

export function getBuiltInAgents(): AgentDefinition[] {
  if (
    isEnvTruthy(process.env.MERCURY_SDK_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return []
  }
  return [
    GENERAL_PURPOSE_AGENT,
    MERCURY_BACKGROUND_AGENT,
    MERCURY_SCOUT_AGENT,
    MERCURY_ARCHITECT_AGENT,
    ...(isGuideAgentMounted() ? [MERCURY_GUIDE_AGENT] : []),
    VERIFICATION_AGENT,
  ]
}
