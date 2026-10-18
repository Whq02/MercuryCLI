import { qwenBoundEndpointLabel, qwenBoundPlanLabel, resolveQwenCredentialSnapshot } from './qwenAccounts.js'

const QWEN_USAGE_CONSOLE = 'modelstudio.console.alibabacloud.com (Usage & Billing)'
const QWEN_USAGE_ABSENCE = `Model Studio documents no usage, balance or quota endpoint an API key can read (the key was the one credential checked) — the session ledger counts this key's tokens and spend; ${QWEN_USAGE_CONSOLE} shows the account's balance and plan windows`

export function qwenUsageView(spend: import('../providerUsage.js').ProviderSessionSpend, credentialed = resolveQwenCredentialSnapshot() !== undefined): import('../providerUsage.js').ActiveSourceUsage {
  if (!credentialed) return { provider: 'qwen', sourceKind: 'none', label: 'Qwen usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins qwen adds a Model Studio key' }
  const plan = qwenBoundPlanLabel()
  if (plan?.kind === 'QwenCloud Token Plan') return { provider: 'qwen', sourceKind: 'api-key', label: 'QwenCloud Token Plan usage', shape: 'api-spend', windows: [], pools: [], spend, tier: plan.kind,
    credits: { state: 'unreported', reason: 'the plan states its quota in the QwenCloud console (qwencloud.com) alone', compact: 'console only' },
    absence: `The key is bound to ${plan.endpoint}: the QwenCloud Token Plan states its quota on qwencloud.com (Token Plan); no endpoint answers it to this client — the session ledger counts this key's tokens.` }
  if (plan) return { provider: 'qwen', sourceKind: 'api-key', label: 'Coding Plan usage', shape: 'api-spend', windows: [], pools: [], spend, tier: plan.kind,
    credits: { state: 'unreported', reason: `the plan counts model calls, not tokens, and states them in the console's Coding Plan page alone`, compact: 'console only' },
    absence: `The key is bound to ${plan.endpoint}: the Coding Plan counts model calls against its 5-hour, weekly and monthly quotas and states them on the console's Coding Plan page; no endpoint answers them to this client — the session ledger counts this key's tokens.` }
  const endpoint = qwenBoundEndpointLabel()
  return { provider: 'qwen', sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: 'API billing',
    credits: { state: 'unreported', reason: `no balance endpoint answers an API key — ${QWEN_USAGE_CONSOLE} shows it`, compact: 'console only' },
    absence: endpoint ? `${QWEN_USAGE_ABSENCE}. The key is bound to ${endpoint}.` : QWEN_USAGE_ABSENCE }
}
