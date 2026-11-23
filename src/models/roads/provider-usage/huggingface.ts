import { API_BILLING_TIER, CREDITS_UNREPORTED } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, ProviderSessionSpend, UsageFigureView } from '../providerUsage.js'
import { HUGGINGFACE_USAGE_ABSENCE_NOTE, type HuggingfaceAccountFacts, huggingfaceAccountFactsFailure, huggingfaceAccountFactsFailureWords, huggingfaceLimitWindow, huggingfaceObservedAccountFacts, huggingfaceObservedRate } from '../huggingface/huggingfaceUsageState.js'
import { resolveHuggingfaceAccount } from '../huggingface/huggingfaceAccounts.js'
import { usageStaleAfterMs } from '../usageFreshness.js'

export function huggingfacePlanFigures(facts: HuggingfaceAccountFacts | null): UsageFigureView[] {
  if (facts === null || facts.isPro === undefined) return []
  const label =
    facts.canPay === true ? 'plan · payment method on file' : facts.canPay === false ? 'plan · no payment method' : 'plan'
  return [
    {
      key: 'plan',
      label,
      value: facts.isPro ? 'PRO' : 'free',
      observedAtMs: facts.observedAtMs,
      ...(facts.periodEndMs !== undefined ? { resetsAtMs: facts.periodEndMs } : {}),
      source: 'endpoint',
      freshForMs: usageStaleAfterMs(),
    },
  ]
}

function huggingfaceTier(kind: 'oauth' | 'api-key', facts: HuggingfaceAccountFacts | null): string {
  if (kind !== 'oauth') return API_BILLING_TIER
  if (facts?.isPro === true) return 'Hugging Face PRO'
  if (facts?.isPro === false) return 'Hugging Face free'
  return 'Hugging Face sign-in'
}

export function huggingfaceUsageView(provider: 'huggingface', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const account = reads?.huggingfaceAccount ? reads.huggingfaceAccount() : resolveHuggingfaceAccount()
  if (!account) {
    return { provider, sourceKind: 'none', label: 'Hugging Face usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins adds Hugging Face' }
  }
  const limitedWindow = (reads?.huggingfaceLimited ?? huggingfaceLimitWindow)()
  const rate = reads?.huggingfaceRate ? reads.huggingfaceRate() : huggingfaceObservedRate()
  const facts = reads?.huggingfaceAccountFacts ? reads.huggingfaceAccountFacts() : huggingfaceObservedAccountFacts()
  const factsFailure = reads?.huggingfaceAccountFactsFailure ? reads.huggingfaceAccountFactsFailure() : huggingfaceAccountFactsFailure()
  const figures: UsageFigureView[] = [
    ...(rate
      ? [
          {
            key: 'rate-remaining',
            label: 'requests remaining (stated by the last response)',
            value: String(rate.remaining),
            observedAtMs: rate.observedAtMs,
            ...(rate.resetsAtMs !== undefined ? { resetsAtMs: rate.resetsAtMs } : {}),
            source: 'headers' as const,
          },
        ]
      : []),
    ...huggingfacePlanFigures(facts),
  ]
  const planNote =
    factsFailure !== null && (facts === null || factsFailure.atMs > facts.observedAtMs)
      ? huggingfaceAccountFactsFailureWords(factsFailure)
      : undefined
  return {
    provider,
    sourceKind: account.kind === 'oauth' ? 'oauth' : 'api-key',
    label: account.kind === 'oauth' ? 'Hugging Face usage' : 'API usage',
    shape: 'api-spend',
    windows: [],
    pools: [],
    credits: CREDITS_UNREPORTED,
    spend,
    ...(figures.length > 0 ? { figures } : {}),
    absence: HUGGINGFACE_USAGE_ABSENCE_NOTE,
    tier: huggingfaceTier(account.kind, facts),
    ...(planNote !== undefined ? { readerNote: planNote, readerNoteCompact: planNote } : {}),
    ...(limitedWindow.state === 'limited' ? { limited: { resetsAtMs: limitedWindow.resetsAtMs } } : {}),
  }
}
