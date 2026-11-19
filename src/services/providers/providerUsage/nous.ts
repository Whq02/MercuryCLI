import { API_BILLING_TIER, laneCredentialedLive, polledBalanceCredits } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, ProviderSessionSpend, UsageFigureView } from '../providerUsage.js'
import { usageStaleAfterMs } from '../usageFreshness.js'

export function nousUsageView(provider: 'nous', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
  if (!credentialed) return { provider, sourceKind: 'none', label: 'Nous Portal usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins nous adds a key' }
  const nousState = require('../nous/nousUsageState.js') as typeof import('../nous/nousUsageState.js')
  const { resolveNousAccount } = require('../nous/nousAccounts.js') as typeof import('../nous/nousAccounts.js')
  const signedIn = (reads?.nousSignedIn ?? (() => resolveNousAccount()?.kind === 'signin'))()
  const account = (reads?.nousAccount ?? nousState.nousObservedAccount)()
  const failed = (reads?.nousAccountFailure ?? nousState.nousAccountFailure)()
  const usable = account?.paidAccess?.totalUsableCredits ?? account?.subscription?.creditsRemaining
  const balance = account && usable !== undefined ? { display: `USD ${usable.toFixed(2)} usable credits`, observedAtMs: account.observedAtMs } : undefined
  const stamp = { source: 'endpoint' as const, observedAtMs: account?.observedAtMs, freshForMs: usageStaleAfterMs() }
  const figures: UsageFigureView[] = []
  if (account) {
    const sub = account.subscription
    if (sub?.plan !== undefined) figures.push({ key: 'plan', label: 'subscription plan', value: `${sub.plan}${sub.tier !== undefined ? ` (tier ${sub.tier})` : ''}`, ...stamp })
    if (sub?.creditsRemaining !== undefined) figures.push({ key: 'subscription-credits', label: 'subscription credits remaining', value: `USD ${sub.creditsRemaining.toFixed(2)}${sub.monthlyCredits !== undefined ? ` of ${sub.monthlyCredits.toFixed(2)} monthly` : ''}`, ...stamp, ...(sub.currentPeriodEnd !== undefined && Number.isFinite(Date.parse(sub.currentPeriodEnd)) ? { resetsAtMs: Date.parse(sub.currentPeriodEnd) } : {}) })
    if (sub?.rolloverCredits !== undefined && sub.rolloverCredits > 0) figures.push({ key: 'rollover-credits', label: 'rollover credits', value: `USD ${sub.rolloverCredits.toFixed(2)}`, ...stamp })
    const access = account.paidAccess
    if (access?.purchasedCreditsRemaining !== undefined) figures.push({ key: 'purchased-credits', label: 'purchased credits remaining', value: `USD ${access.purchasedCreditsRemaining.toFixed(2)}`, ...stamp })
    if (access?.memberSpendCapUsd !== undefined) figures.push({ key: 'member-spend-cap', label: 'organisation spend cap', value: `USD ${(access.memberSpendUsd ?? 0).toFixed(2)} of ${access.memberSpendCapUsd.toFixed(2)}`, ...stamp })
  }
  const note = account?.paidAccess?.allowed === false
    ? `the Portal reports no paid service access${account.paidAccess.reason ? ` (${account.paidAccess.reason})` : ''} — top up or renew at portal.nousresearch.com`
    : failed ? nousState.nousAccountFailureWords(failed) : undefined
  return {
    provider, sourceKind: signedIn ? 'oauth' : 'api-key', label: signedIn ? 'Nous Portal account' : 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: signedIn ? (account?.subscription?.plan !== undefined ? `${account.subscription.plan} plan` : 'Nous Portal account') : API_BILLING_TIER,
    credits: balance ? polledBalanceCredits(balance) : { state: 'unreported', reason: failed ? 'not read — see the usage reader note' : 'not read yet — /usage samples the Portal account endpoint', compact: failed ? 'not read' : 'not read yet' },
    ...(balance ? { balance } : {}),
    ...(figures.length ? { figures } : {}),
    ...(note ? { readerNote: note, readerNoteCompact: note } : {}),
  }
}
