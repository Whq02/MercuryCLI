import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { getRateLimitTier, getSubscriptionType } from './auth.js'


export function getPlanModeV2AgentCount(): number {
  const subscription = getSubscriptionType()
  if (subscription === 'max' && getRateLimitTier() === 'default_claude_max_20x') return 3
  if (subscription === 'enterprise' || subscription === 'team') return 3
  return 1
}

export function getPlanModeV2ExploreAgentCount(): number {
  return 3
}

export function isPlanModeInterviewPhaseEnabled(): boolean {
  return flagEnabled('MERCURY_INTERVIEW')
}

export type PewterLedgerVariant = 'trim' | 'cut' | 'cap' | null

export function getPewterLedgerVariant(): PewterLedgerVariant {
  const value = getFeatureValue_CACHED_MAY_BE_STALE<string | null>('mercury_pewter_ledger', null)
  return value === 'trim' || value === 'cut' || value === 'cap' ? value : null
}
