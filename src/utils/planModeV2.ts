import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { getRateLimitTier, getSubscriptionType } from './auth.js'

/**
 * Plan-mode agent fan-out counts and the interview-phase / plan-prompt
 * gates.
 */

export function getPlanModeV2AgentCount(): number {
  const subscription = getSubscriptionType()
  if (subscription === 'max' && getRateLimitTier() === 'default_claude_max_20x') return 3
  if (subscription === 'enterprise' || subscription === 'team') return 3
  return 1
}

export function getPlanModeV2ExploreAgentCount(): number {
  return 3
}

/**
 * In Mercury the interview workflow IS the standard plan path: the decision
 * is the registered default-on flag alone — no external boundary override
 * exists.
 */
export function isPlanModeInterviewPhaseEnabled(): boolean {
  return flagEnabled('MERCURY_INTERVIEW')
}

export type PewterLedgerVariant = 'trim' | 'cut' | 'cap' | null

/** Only the three named values are accepted; anything else resolves to the control. */
export function getPewterLedgerVariant(): PewterLedgerVariant {
  const value = getFeatureValue_CACHED_MAY_BE_STALE<string | null>('mercury_pewter_ledger', null)
  return value === 'trim' || value === 'cut' || value === 'cap' ? value : null
}
