// Built-in agent roster assembly + the legacy subagent-type alias map
// The roster is assembled per call so entrypoint and env
// changes take effect; its ORDER is load-bearing — built-ins lead the
// emission order, and the emission order is the tool prompt's byte order.

import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { MERCURY_ARCHITECT_AGENT } from './built-in/mercuryArchitectAgent.js'
import { MERCURY_BACKGROUND_AGENT } from './built-in/mercuryBackgroundAgent.js'
import { MERCURY_GUIDE_AGENT, isGuideAgentMounted } from './built-in/mercuryGuideAgent.js'
import { MERCURY_SCOUT_AGENT } from './built-in/mercuryScoutAgent.js'
import { VERIFICATION_AGENT } from './built-in/verificationAgent.js'

/**
 * Legacy subagent-type aliases (contract data — historical manifests,
 * wrapper routing, and operator muscle memory still emit them). Decoded at
 * the tool's type-resolution seam only (roleResolver.decodeAgentType);
 * nothing new writes the legacy ids.
 */
export const LEGACY_SUBAGENT_ALIASES: Readonly<Record<string, string>> = {
  claude: 'mercury-background',
  Explore: 'mercury-scout',
  Plan: 'mercury-architect',
}

/**
 * The registered built-in roster, assembled per call. Order is fixed and
 * load-bearing: general-purpose, status-line setup, background, scout,
 * architect, then the guide when present, then verification. The guide's
 * slot reads the ONE mount law (isGuideAgentMounted — mercuryGuideAgent.ts),
 * the same predicate the system prompt's guide line reads.
 */
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
