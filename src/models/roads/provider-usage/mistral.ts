import { API_BILLING_TIER, laneCredentialedLive, polledBalanceCredits } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, ProviderSessionSpend, UsageFigureView } from '../providerUsage.js'
import { usageStaleAfterMs } from '../usageFreshness.js'

export function mistralUsageView(provider: 'mistral', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
  if (!credentialed) return { provider, sourceKind: 'none', label: 'Mistral usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins mistral adds a key' }
  const state = require('../mistral/mistralUsageState.js') as typeof import('../mistral/mistralUsageState.js')
  const { resolveMistralAdminApiKey } = require('../mistral/mistralAccounts.js') as typeof import('../mistral/mistralAccounts.js')
  const admin = reads?.mistralAdminKeyPresent?.() ?? resolveMistralAdminApiKey() !== undefined
  const observed = (reads?.mistralObserved ?? state.mistralObservedUsage)()
  const account = observed.identity?.email ?? observed.identity?.name
  const scope = [observed.identity?.organization, observed.identity?.workspace].filter((part): part is string => typeof part === 'string' && part !== '').join(' / ')
  const figures: UsageFigureView[] = []
  const identityNote = observed.failure?.endpoint === 'identity' ? state.mistralUsageFailureWords(observed.failure) : undefined
  if (account) figures.push({ key: 'account', label: 'account', value: scope ? `${account} (${scope})` : account })
  if (!admin) return {
    provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER,
    credits: { state: 'unreported', reason: 'not read — an Admin API key unlocks the organisation meter', compact: 'needs admin key' },
    absence: state.MISTRAL_ADMIN_KEY_HINT,
    ...(figures.length ? { figures } : {}),
    ...(identityNote ? { readerNote: identityNote, readerNoteCompact: identityNote } : {}),
  }
  const limits = observed.limits
  const stamp = { source: 'endpoint' as const, observedAtMs: limits?.observedAtMs, freshForMs: usageStaleAfterMs() }
  const spent = limits?.totalUsage ?? limits?.usage
  let balance: { display: string; observedAtMs: number } | undefined
  if (limits) {
    if (spent !== undefined) figures.push({ key: 'month-usage', label: 'organisation usage this month', value: `${limits.currency} ${spent.toFixed(2)}`, ...stamp })
    if (limits.vibeUsage !== undefined && limits.vibeUsage > 0) figures.push({ key: 'vibe-usage', label: 'of which Vibe Code usage', value: `${limits.currency} ${limits.vibeUsage.toFixed(2)}`, ...stamp })
    if (limits.noMonthlyLimit) figures.push({ key: 'month-limit', label: 'monthly spend limit', value: 'none set', ...stamp })
    else if (limits.usageLimit !== undefined) {
      figures.push({ key: 'month-limit', label: 'monthly spend limit', value: `${limits.currency} ${limits.usageLimit.toFixed(2)}${limits.monthlyLimitReached ? ' · reached' : ''}`, ...stamp })
      if (spent !== undefined) balance = { display: `${limits.currency} ${Math.max(0, limits.usageLimit - spent).toFixed(2)} left of the monthly limit`, observedAtMs: limits.observedAtMs }
    }
    if (limits.requestsPerSecond !== undefined) figures.push({ key: 'rate-limit', label: 'rate limit', value: `${limits.requestsPerSecond} requests/s`, ...stamp })
    if (limits.lastPaymentFailure) figures.push({ key: 'payment', label: 'last payment', value: 'failed — check admin.mistral.ai', ...stamp })
  }
  const adminNote = observed.failure?.endpoint === 'admin' ? state.mistralUsageFailureWords(observed.failure) : undefined
  const note = adminNote ?? identityNote
  return {
    provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER,
    credits: balance ? polledBalanceCredits(balance) : limits
      ? { state: 'unreported', reason: limits.noMonthlyLimit ? 'no monthly limit is set — usage is the figure' : 'the spend limit read states no figure', compact: limits.noMonthlyLimit ? 'no limit set' : 'not stated' }
      : { state: 'unreported', reason: adminNote ? 'not read — see the usage reader note' : 'not read yet — /usage samples the Admin API', compact: 'not read' },
    ...(balance ? { balance } : {}),
    ...(figures.length ? { figures } : {}),
    ...(note ? { readerNote: note, readerNoteCompact: note } : {}),
  }
}
