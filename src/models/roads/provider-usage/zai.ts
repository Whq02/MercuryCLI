import { API_BILLING_TIER, CREDITS_UNREPORTED, planWord, usageWindowLabel } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, ProviderSessionSpend, UsageFigureView, UsageWindowView, ZaiObservedQuotaView, ZaiQuotaFailureView } from '../providerUsage.js'
import { resolveZaiDispatch } from '../providerDiscovery.js'
import { usageStaleAfterMs } from '../usageFreshness.js'

export function zaiAccountFacts(): { plan: 'general' | 'coding'; source: 'env' | 'stored' } | undefined {
  const dispatch = resolveZaiDispatch()
  return dispatch ? { plan: dispatch.plan, source: dispatch.source } : undefined
}

function liveZaiQuota(): ZaiObservedQuotaView | null {
  const { zaiObservedQuota } = require('../zai/zaiUsageState.js') as typeof import('../zai/zaiUsageState.js')
  return zaiObservedQuota()
}

function liveZaiQuotaFailure(): ZaiQuotaFailureView | null {
  const { zaiLastQuotaFailure } = require('../zai/zaiUsageState.js') as typeof import('../zai/zaiUsageState.js')
  return zaiLastQuotaFailure()
}

export function zaiQuotaWindowViews(quota: ZaiObservedQuotaView | null): UsageWindowView[] {
  if (!quota) return []
  const seen = new Map<string, number>()
  const credit = quota.windows
    .filter(w => w.kind === 'credit')
    .sort((a, b) => (a.windowMinutes ?? Number.POSITIVE_INFINITY) - (b.windowMinutes ?? Number.POSITIVE_INFINITY))
  return credit.map(w => {
    const label = w.windowMinutes === 7 * 24 * 60 ? '7d' : usageWindowLabel(w.windowMinutes)
    const count = (seen.get(label) ?? 0) + 1
    seen.set(label, count)
    return {
      key: count === 1 ? label : `${label}#${count}`,
      label,
      state: 'live',
      usedPct: w.usedPct,
      ...(w.resetsAtMs !== undefined ? { resetsAtMs: w.resetsAtMs } : {}),
      observedAtMs: quota.observedAtMs,
      source: 'endpoint',
    }
  })
}

export function zaiQuotaFigures(quota: ZaiObservedQuotaView | null): UsageFigureView[] {
  if (!quota) return []
  const stamp = { observedAtMs: quota.observedAtMs, source: 'endpoint' as const, freshForMs: usageStaleAfterMs() }
  return quota.windows
    .filter(w => w.kind === 'tool-calls')
    .map(w => ({
      key: 'tool-calls',
      label: 'MCP tool calls this month',
      value: w.used !== undefined && w.limit !== undefined ? `${w.used} of ${w.limit}` : `${Math.round(w.usedPct)}% used`,
      ...(w.resetsAtMs !== undefined ? { resetsAtMs: w.resetsAtMs } : {}),
      ...stamp,
    }))
}

const ZAI_GENERAL_KEY_ABSENCE_NOTE =
  'No usage road for a general Z.AI key — https://z.ai/manage-apikey/billing is the view'

const ZAI_NO_PLAN_NOTE = 'usage: not on a coding plan'

export function zaiUsageView(provider: 'zai', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const account = reads?.zaiAccount ? reads.zaiAccount() : zaiAccountFacts()
  const keyPresent = reads?.zaiKeyPresent?.() ?? account !== undefined
  if (!keyPresent) {
    return { provider, sourceKind: 'none', label: 'Z.AI usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins zai adds a key' }
  }
  if (account?.plan !== 'coding') {
    return { provider, sourceKind: 'api-key', label: 'Z.AI usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER, absence: ZAI_GENERAL_KEY_ABSENCE_NOTE, credits: CREDITS_UNREPORTED }
  }
  const quota = reads?.zaiQuota ? reads.zaiQuota() : liveZaiQuota()
  const failure = reads?.zaiQuotaFailure ? reads.zaiQuotaFailure() : liveZaiQuotaFailure()
  const { isZaiNoPlanFailure, zaiQuotaFailureWords } = require('../zai/zaiUsageState.js') as typeof import('../zai/zaiUsageState.js')
  if (quota === null && failure !== null && isZaiNoPlanFailure(failure)) {
    return { provider, sourceKind: 'api-key', label: 'Z.AI usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER, absence: ZAI_NO_PLAN_NOTE, credits: CREDITS_UNREPORTED }
  }
  const figures = zaiQuotaFigures(quota)
  const note = failure !== null && (quota === null || failure.atMs > quota.observedAtMs) ? zaiQuotaFailureWords(failure) : undefined
  return {
    provider,
    sourceKind: 'api-key',
    label: 'GLM Coding Plan usage',
    shape: 'subscription-windows',
    windows: zaiQuotaWindowViews(quota),
    pools: [],
    spend,
    tier: quota?.level ? `GLM Coding ${planWord(quota.level)}` : 'GLM Coding Plan',
    ...(figures.length > 0 ? { figures } : {}),
    ...(note !== undefined ? { readerNote: note, readerNoteCompact: note } : {}),
  }
}
