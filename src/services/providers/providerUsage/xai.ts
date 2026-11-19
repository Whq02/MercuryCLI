import { API_BILLING_TIER, CARRY_NOTHING_TAIL, CARRY_UNSTATED_COMPACT, laneCredentialedLive, polledBalanceCredits, usageWindowLabel } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, ProviderSessionSpend, UsageCarryView, UsageCreditsView, UsageFigureView, UsageWindowView } from '../providerUsage.js'
import { XAI_MANAGEMENT_KEY_HINT, type XaiSubscriptionCredits, xaiObservedSubscriptionCredits, xaiObservedUsage, xaiUsageFailureWords } from '../xai/xaiUsageState.js'
import { resolveXaiManagementApiKey } from '../xai/xaiAccounts.js'
import { usageStaleAfterMs } from '../usageFreshness.js'

export function xaiSubscriptionWindowViews(pool: XaiSubscriptionCredits | null): UsageWindowView[] {
  if (!pool || pool.usedPercent === undefined) return []
  const type = pool.period?.type ?? ''
  const span = pool.period?.startMs !== undefined && pool.period.endMs !== undefined && pool.period.endMs > pool.period.startMs
    ? (pool.period.endMs - pool.period.startMs) / 60_000
    : type.endsWith('WEEKLY') ? 7 * 24 * 60 : type.endsWith('MONTHLY') ? 30 * 24 * 60 : undefined
  const label = usageWindowLabel(span)
  return [{
    key: label,
    label,
    state: 'live',
    usedPct: Math.min(100, Math.max(0, pool.usedPercent)),
    ...(pool.period?.endMs !== undefined ? { resetsAtMs: pool.period.endMs } : {}),
    observedAtMs: pool.observedAtMs,
    source: 'endpoint',
    freshForMs: usageStaleAfterMs(),
  }]
}

export const XAI_POOL_NOT_READ_WORDS = 'not read yet — /usage samples the Grok pool endpoint'

export const XAI_POOL_UNSTATED_WORDS = 'the Grok pool endpoint stated no included usage for this period'

function xaiSubscriptionCredits(pool: XaiSubscriptionCredits | null, failed: boolean): UsageCreditsView {
  if (pool === null) return { state: 'unreported', reason: failed ? 'not read — see the usage reader note' : XAI_POOL_NOT_READ_WORDS, compact: failed ? 'not read' : 'not read yet' }
  if (pool.prepaidBalanceUsd === undefined) return { state: 'unreported', reason: 'the Grok pool endpoint stated no purchased-credits balance', compact: 'not stated' }
  const amount = `USD ${pool.prepaidBalanceUsd.toFixed(2)}`
  return { state: 'reported', display: `${amount} purchased credits`, compact: `${amount} purchased`, source: 'endpoint', observedAtMs: pool.observedAtMs, freshForMs: usageStaleAfterMs() }
}

export function xaiPurchasedCreditsCarry(pool: XaiSubscriptionCredits | null, failed: boolean): UsageCarryView {
  if (pool === null) return { state: 'unstated', display: failed ? 'not read — see the usage reader note' : XAI_POOL_NOT_READ_WORDS, compact: failed ? 'not read' : 'not read yet' }
  const stamp = { source: 'endpoint' as const, observedAtMs: pool.observedAtMs, freshForMs: usageStaleAfterMs() }
  if (pool.prepaidBalanceUsd === undefined) return { state: 'unstated', display: 'the Grok pool endpoint stated no purchased-credits balance', compact: CARRY_UNSTATED_COMPACT, ...stamp }
  const amount = `USD ${pool.prepaidBalanceUsd.toFixed(2)}`
  if (pool.prepaidBalanceUsd <= 0) return { state: 'nothing', display: `purchased credits ${amount} — ${CARRY_NOTHING_TAIL}`, compact: `purchased credits ${amount}`, ...stamp }
  return { state: 'carries', display: `on purchased credits · ${amount} left`, compact: `on purchased credits ${amount}`, ...stamp }
}

export function xaiUsageView(provider: 'xai', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
  if (!credentialed) return { provider, sourceKind: 'none', label: 'xAI usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins xai adds a key' }
  const { resolveXaiAccount } = require('../xai/xaiAccounts.js') as typeof import('../xai/xaiAccounts.js')
  if ((reads?.xaiAccount ?? resolveXaiAccount)()?.kind === 'grok-subscription') {
    const { credits: pool, failure: poolFailure } = (reads?.xaiSubscriptionCredits ?? xaiObservedSubscriptionCredits)()
    const windows = xaiSubscriptionWindowViews(pool)
    const note = poolFailure ? xaiUsageFailureWords(poolFailure) : undefined
    return {
      provider, sourceKind: 'subscription-oauth', label: 'Grok subscription', shape: 'subscription-windows', windows, pools: [], spend,
      tier: pool?.tier ?? 'Grok subscription', credits: xaiSubscriptionCredits(pool, poolFailure !== null),
      carry: xaiPurchasedCreditsCarry(pool, poolFailure !== null),
      ...(pool && windows.length === 0 ? { absence: XAI_POOL_UNSTATED_WORDS } : {}),
      ...(note ? { readerNote: note, readerNoteCompact: note } : {}),
    }
  }
  const management = reads?.xaiManagementKeyPresent?.() ?? resolveXaiManagementApiKey() !== undefined
  if (!management) return {
    provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER,
    credits: { state: 'unreported', reason: 'not read — a management key unlocks the team balance', compact: 'needs management key' },
    absence: XAI_MANAGEMENT_KEY_HINT,
  }
  const { usage, failure } = (reads?.xaiObserved ?? xaiObservedUsage)()
  const stamp = { source: 'endpoint' as const, observedAtMs: usage?.observedAtMs, freshForMs: usageStaleAfterMs() }
  const balance = usage ? { display: `USD ${usage.prepaidBalanceUsd.toFixed(2)} prepaid`, observedAtMs: usage.observedAtMs } : undefined
  const figures: UsageFigureView[] = []
  if (usage) {
    const cycle = `${usage.cycle.year}-${String(usage.cycle.month).padStart(2, '0')}`
    figures.push({ key: 'team-cycle', label: `team usage (${cycle}${usage.partial ? ', partial' : ''})`, value: `USD ${usage.usageUsd.toFixed(2)}`, ...stamp })
    if (usage.postpaidInvoiceUsd !== undefined) figures.push({ key: 'postpaid-preview', label: 'postpaid invoice preview (with VAT)', value: `USD ${usage.postpaidInvoiceUsd.toFixed(2)}`, ...stamp })
    if (usage.postpaidLimitUsd !== undefined) figures.push({ key: 'postpaid-limit', label: 'postpaid spending limit', value: `USD ${usage.postpaidLimitUsd.toFixed(2)}`, ...stamp })
  }
  const note = failure ? xaiUsageFailureWords(failure) : usage?.partial ? 'usage query returned only part of the results — this is not a spending-limit signal' : undefined
  return {
    provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER,
    credits: balance ? polledBalanceCredits(balance) : { state: 'unreported', reason: failure ? 'not read — see the usage reader note' : 'not read yet — /usage samples the Management API', compact: 'not read' },
    ...(balance ? { balance } : {}),
    ...(figures.length ? { figures } : {}),
    ...(note ? { readerNote: note, readerNoteCompact: note } : {}),
  }
}
