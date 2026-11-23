import { API_BILLING_TIER, CARRY_NOTHING_TAIL, polledBalanceCredits, usageWindowLabel } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, KimiManagedUsageView, KimiUsageWindowView, MoonshotObservedBalanceView, ProviderSessionSpend, UsageCarryView, UsageCreditsView, UsageWindowView } from '../providerUsage.js'
import { usageStaleAfterMs } from '../usageFreshness.js'

function liveMoonshotBalance(): MoonshotObservedBalanceView | null {
  const { moonshotObservedBalance } =
    require('../moonshot/moonshotUsageState.js') as typeof import('../moonshot/moonshotUsageState.js')
  return moonshotObservedBalance()
}

function liveMoonshotAccount(): { kind: 'kimi-oauth' | 'api-key' } | undefined {
  const { resolveMoonshotAccount } =
    require('../moonshot/moonshotAccounts.js') as typeof import('../moonshot/moonshotAccounts.js')
  return resolveMoonshotAccount()
}

function liveKimiManagedUsage(): KimiManagedUsageView | null {
  const { kimiObservedManagedUsage } =
    require('../moonshot/moonshotUsageState.js') as typeof import('../moonshot/moonshotUsageState.js')
  return kimiObservedManagedUsage()
}

export function kimiManagedWindowViews(usage: KimiManagedUsageView | null): UsageWindowView[] {
  if (!usage) return []
  const seen = new Map<string, number>()
  const view = (w: KimiUsageWindowView, fallbackLabel: string): UsageWindowView => {
    const label = w.windowMinutes === 7 * 24 * 60 ? '7d' : w.windowMinutes !== undefined ? usageWindowLabel(w.windowMinutes) : fallbackLabel
    const count = (seen.get(label) ?? 0) + 1
    seen.set(label, count)
    const usedPct = w.usedRatio !== undefined ? w.usedRatio * 100 : w.used !== undefined && w.limit !== undefined && w.limit > 0 ? (w.used / w.limit) * 100 : undefined
    return {
      key: count === 1 ? label : `${label}#${count}`,
      label,
      state: 'live',
      ...(usedPct !== undefined ? { usedPct: Math.min(100, Math.max(0, usedPct)) } : {}),
      ...(w.resetsAtMs !== undefined ? { resetsAtMs: w.resetsAtMs } : {}),
      observedAtMs: usage.observedAtMs,
      source: 'endpoint',
    }
  }
  const windows = [...usage.windows].sort(
    (a, b) => (a.windowMinutes ?? Number.POSITIVE_INFINITY) - (b.windowMinutes ?? Number.POSITIVE_INFINITY),
  )
  const views = windows.map(w => view(w, w.name ?? 'win'))
  if (usage.quota) views.push(view(usage.quota, 'quota'))
  return views
}

function kimiManagedCredits(usage: KimiManagedUsageView | null, error?: string): UsageCreditsView {
  if (usage === null) return { state: 'unreported', reason: error ?? 'not read yet — /usage samples Kimi /usages', compact: error ? 'not read' : 'not read yet' }
  if (usage.extraUsage === undefined) return {
    state: 'unreported',
    reason: 'Kimi /usages states no Extra Usage balance with a currency — Kimi Code Console shows membership billing',
    compact: 'not stated',
  }
  const amount = `${usage.extraUsage.currency} ${usage.extraUsage.balance}`
  return { state: 'reported', display: `${amount} Extra Usage balance`, compact: `${amount} extra`, source: 'endpoint', observedAtMs: usage.observedAtMs, freshForMs: usageStaleAfterMs() }
}

export const KIMI_EXTRA_USAGE_NOT_READ_WORDS = 'Extra Usage not read yet — /usage samples Kimi /usages'

export const KIMI_EXTRA_USAGE_UNSTATED_WORDS = 'no Extra Usage balance stated — Kimi Code Console shows membership billing'

function kimiExtraUsageCarry(usage: KimiManagedUsageView | null, error?: string): UsageCarryView {
  if (usage === null) return { state: 'unstated', display: error ?? KIMI_EXTRA_USAGE_NOT_READ_WORDS, compact: error ? 'Extra Usage not read' : 'Extra Usage not read yet' }
  const stamp = { source: 'endpoint' as const, observedAtMs: usage.observedAtMs, freshForMs: usageStaleAfterMs() }
  if (usage.extraUsage === undefined) return { state: 'unstated', display: KIMI_EXTRA_USAGE_UNSTATED_WORDS, compact: 'Extra Usage not stated', ...stamp }
  const amount = `${usage.extraUsage.currency} ${usage.extraUsage.balance}`
  const value = Number(usage.extraUsage.balance)
  if (Number.isFinite(value) && value <= 0) return { state: 'nothing', display: `Extra Usage balance ${amount} — ${CARRY_NOTHING_TAIL}`, compact: `Extra Usage ${amount}`, ...stamp }
  return { state: 'carries', display: `on Extra Usage · ${amount} left`, compact: `on Extra Usage ${amount}`, ...stamp }
}

export function moonshotUsageView(provider: 'moonshot', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const account = reads?.moonshotAccount ? reads.moonshotAccount() : liveMoonshotAccount()
  if (!account) {
    return { provider, sourceKind: 'none', label: 'Moonshot usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins moonshot adds Kimi or a key' }
  }
  if (account.kind === 'kimi-oauth') {
    const managed = reads?.kimiManagedUsage ? reads.kimiManagedUsage() : liveKimiManagedUsage()
    const error = reads?.kimiManagedError ? reads.kimiManagedError() : reads?.kimiManagedUsage ? undefined : (require('../moonshot/moonshotUsageState.js') as typeof import('../moonshot/moonshotUsageState.js')).kimiManagedUsageError()
    return {
      provider,
      sourceKind: 'oauth',
      label: 'Kimi usage',
      shape: 'subscription-windows',
      windows: kimiManagedWindowViews(managed),
      pools: [],
      credits: kimiManagedCredits(managed, error),
      carry: kimiExtraUsageCarry(managed, error),
      ...(error ? { readerNote: error, readerNoteCompact: error } : {}),
      spend,
      tier: 'Kimi sign-in',
    }
  }
  const record = reads?.moonshotBalance?.() ?? liveMoonshotBalance()
  const balance = record
    ? { display: `USD ${record.availableBalance}`, observedAtMs: record.observedAtMs }
    : undefined
  return {
    provider,
    sourceKind: 'api-key',
    label: 'API usage',
    shape: 'api-spend',
    windows: [],
    pools: [],
    credits: polledBalanceCredits(balance),
    spend,
    tier: API_BILLING_TIER,
    ...(balance ? { balance } : {}),
  }
}
