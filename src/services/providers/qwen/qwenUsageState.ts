import { qwenBoundEndpointLabel, resolveQwenCredentialSnapshot } from './qwenAccounts.js'

const QWEN_USAGE_CONSOLE = 'modelstudio.console.alibabacloud.com (Usage & Billing)'
const QWEN_USAGE_ABSENCE = `Model Studio documents no usage, balance or quota endpoint an API key can read (the key was the one credential checked) — the session ledger counts this key's tokens and spend; ${QWEN_USAGE_CONSOLE} shows the account's balance and plan windows`

export function qwenUsageView(spend: import('../providerUsage.js').ProviderSessionSpend, credentialed = resolveQwenCredentialSnapshot() !== undefined): import('../providerUsage.js').ActiveSourceUsage {
  if (!credentialed) return { provider: 'qwen', sourceKind: 'none', label: 'Qwen usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins qwen adds a Model Studio key' }
  const endpoint = qwenBoundEndpointLabel()
  return { provider: 'qwen', sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: 'API billing',
    credits: { state: 'unreported', reason: `no balance endpoint answers an API key — ${QWEN_USAGE_CONSOLE} shows it`, compact: 'console only' },
    absence: endpoint ? `${QWEN_USAGE_ABSENCE}. The key is bound to ${endpoint}.` : QWEN_USAGE_ABSENCE }
}
