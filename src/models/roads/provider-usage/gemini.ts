import { API_BILLING_TIER, CREDITS_UNREPORTED } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, ProviderSessionSpend, UsageFigureView } from '../providerUsage.js'
import { GEMINI_PLAN_USAGE_ABSENCE_NOTE, GEMINI_USAGE_ABSENCE_NOTE, geminiLimitWindow } from '../gemini/geminiUsageState.js'
import { geminiPlanFacts, resolveGeminiAccount } from '../gemini/geminiAccounts.js'
import { geminiPlanQuotaReadNote } from '../gemini/geminiPlanQuota.js'
import { geminiPlanTierWords } from '../gemini/geminiPlanAccess.js'
import { getCachedGeminiCatalogue } from '../gemini/geminiCatalogue.js'
import { usageStaleAfterMs } from '../usageFreshness.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export function geminiPlanUsageFigures(plan: NonNullable<ReturnType<typeof geminiPlanFacts>>, env: NodeJS.ProcessEnv = hostEnv()): UsageFigureView[] {
  const figures: UsageFigureView[] = [
    { key: 'plan-tier', label: 'tier Google reports', value: geminiPlanTierWords(plan.tier), ...(plan.tierReadAtMs !== undefined ? { observedAtMs: plan.tierReadAtMs } : {}), source: 'endpoint', freshForMs: 24 * 60 * 60 * 1000 },
  ]
  const roster = getCachedGeminiCatalogue('plan', env)
  if (roster && roster.fetchedAtMs > 0) {
    for (const model of roster.models) {
      if (!model.quota || model.quota.remainingFraction === undefined) continue
      const resetsAtMs = model.quota.resetTime !== undefined ? Date.parse(model.quota.resetTime) : NaN
      figures.push({
        key: `plan-quota:${model.id}`,
        label: `${model.displayName ?? model.id} quota left`,
        value: `${Math.round(model.quota.remainingFraction * 100)}%`,
        observedAtMs: roster.fetchedAtMs,
        ...(Number.isFinite(resetsAtMs) ? { resetsAtMs } : {}),
        source: 'endpoint',
        freshForMs: usageStaleAfterMs(),
      })
    }
  }
  return figures
}

export function geminiUsageView(provider: 'gemini', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const account = reads?.geminiAccount ? reads.geminiAccount() : resolveGeminiAccount()
  if (!account) {
    return { provider, sourceKind: 'none', label: 'Gemini usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins adds Gemini' }
  }
  const limitedWindow = (reads?.geminiLimited ?? geminiLimitWindow)()
  const plan = account.kind === 'plan' ? geminiPlanFacts() : undefined
  const planFigures = plan ? geminiPlanUsageFigures(plan) : []
  const planNote = plan ? geminiPlanQuotaReadNote(getCachedGeminiCatalogue('plan')) : undefined
  return {
    provider,
    sourceKind: account.kind === 'plan' ? 'oauth' : account.kind,
    label: account.kind === 'api-key' ? 'API usage' : 'Gemini usage',
    shape: 'api-spend',
    windows: [],
    pools: [],
    credits: CREDITS_UNREPORTED,
    spend,
    absence: plan ? GEMINI_PLAN_USAGE_ABSENCE_NOTE : GEMINI_USAGE_ABSENCE_NOTE,
    ...(planFigures.length > 0 ? { figures: planFigures } : {}),
    ...(planNote !== undefined ? { readerNote: planNote, readerNoteCompact: planNote } : {}),
    tier: plan ? geminiPlanTierWords(plan.tier) : account.kind === 'oauth' ? 'Google sign-in' : API_BILLING_TIER,
    ...(limitedWindow.state === 'limited'
      ? { limited: { resetsAtMs: limitedWindow.resetsAtMs } }
      : {}),
  }
}
