import { API_BILLING_TIER, CREDITS_UNREPORTED, laneCredentialedLive, polledBalanceCredits } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, DeepseekObservedBalanceView, ProviderSessionSpend } from '../providerUsage.js'

function liveDeepseekBalance(): DeepseekObservedBalanceView | null {
  const { deepseekObservedBalance } =
    require('../deepseek/deepseekUsageState.js') as typeof import('../deepseek/deepseekUsageState.js')
  return deepseekObservedBalance()
}

const COMPAT_USAGE_ABSENCE_NOTE =
  "a custom endpoint publishes no usage Mercury reads — the endpoint's own dashboard is the view"

export function deepseekUsageView(provider: 'deepseek' | 'openai-compat', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
  const uncredentialedLabel = provider === 'deepseek' ? 'DeepSeek usage' : 'Endpoint usage'
  if (!credentialed) {
    const whyNot =
      provider === 'deepseek'
        ? 'not connected — /logins deepseek adds a key'
        : 'not configured — set MERCURY_COMPAT_BASE_URL'
    return { provider, sourceKind: 'none', label: uncredentialedLabel, shape: 'none', windows: [], pools: [], spend, whyNot }
  }
  const record = provider === 'deepseek' ? (reads?.deepseekBalance?.() ?? liveDeepseekBalance()) : null
  const primary = record?.balances[0]
  const balance =
    record && primary
      ? { display: `${primary.currency} ${primary.totalBalance}`, observedAtMs: record.observedAtMs }
      : undefined
  return {
    provider,
    sourceKind: 'api-key',
    label: 'API usage',
    shape: 'api-spend',
    windows: [],
    pools: [],
    credits: provider === 'deepseek' ? polledBalanceCredits(balance) : CREDITS_UNREPORTED,
    spend,
    tier: API_BILLING_TIER,
    ...(balance ? { balance } : {}),
    ...(record && !record.isAvailable
      ? { readerNote: 'the provider marks this account unavailable for inference' }
      : {}),
    ...(provider === 'openai-compat' ? { absence: COMPAT_USAGE_ABSENCE_NOTE } : {}),
  }
}
