import { API_BILLING_TIER, laneCredentialedLive } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, ProviderSessionSpend } from '../providerUsage.js'

export function togetherUsageView(provider: 'together' | 'cohere', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
  const words = provider === 'together' ? { label: 'Together AI usage', door: '/logins together', console: 'api.together.ai/settings/billing' } : { label: 'Cohere usage', door: '/logins cohere', console: 'dashboard.cohere.com' }
  if (!credentialed) return { provider, sourceKind: 'none', label: words.label, shape: 'none', windows: [], pools: [], spend, whyNot: `not connected — ${words.door} adds a key` }
  return {
    provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER,
    credits: { state: 'unreported', reason: `a standard API key reads no balance endpoint — ${words.console} shows it`, compact: 'console only' },
    absence: `a standard ${provider === 'together' ? 'Together AI' : 'Cohere'} API key reads no usage, balance or quota endpoint — the session ledger counts this key's tokens; ${words.console} shows the account's spend`,
  }
}
