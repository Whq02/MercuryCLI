import { API_BILLING_TIER } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, ProviderSessionSpend, UsageCreditsView, UsageFigureView, UsageWindowView } from '../providerUsage.js'
import { type OpenrouterKeyUsage, openrouterLimitWindow, openrouterLowBalanceNote, openrouterObservedKeyUsage } from '../openrouter/openrouterUsageState.js'
import { readMintedOpenrouterKey, resolveOpenrouterApiKey } from '../openrouter/openrouterAccounts.js'
import { usageStaleAfterMs } from '../usageFreshness.js'

export function openrouterObservedWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  const observed = (reads?.openrouterObserved ?? openrouterObservedKeyUsage)()
  const usage = observed.usage
  if (!usage) return []
  const { limit, limitRemaining } = usage
  if (typeof limit !== 'number' || limit <= 0 || typeof limitRemaining !== 'number') return []
  const usedPct = Math.min(100, Math.max(0, ((limit - limitRemaining) / limit) * 100))
  return [
    {
      key: 'cap',
      label: 'cap',
      state: 'live',
      usedPct,
      observedAtMs: usage.observedAtMs,
      source: 'endpoint',
    },
  ]
}

function openrouterBudgetLabel(scope: NonNullable<OpenrouterKeyUsage['effectiveBudget']>['scope']): string {
  return { workspace_default_member: 'workspace member', workspace_default_key: 'workspace key', member: 'member', api_key: 'API key', workspace: 'workspace', key_limit: 'key' }[scope]
}

function openrouterCredits(observed: { usage: OpenrouterKeyUsage | null; lastError?: string }): UsageCreditsView {
  const usage = observed.usage
  if (usage === null) {
    return observed.lastError !== undefined
      ? { state: 'unreported', reason: 'not read — see the failed key slot', compact: 'not read' }
      : { state: 'unreported', reason: 'not read yet — /usage samples the key endpoint', compact: 'not read yet' }
  }
  const budget = usage.effectiveBudget
  if (budget) {
    const cap = typeof usage.limitRemaining === 'number' ? `$${usage.limitRemaining.toFixed(2)} key cap ${usage.limitReset ?? (usage.limitReset === null ? 'never' : '')}` : usage.limit === null ? 'key cap uncapped' : 'key cap unstated'
    return {
      state: 'reported',
      display: `${cap.trim()} · $${budget.remainingUsd.toFixed(2)} ${openrouterBudgetLabel(budget.scope)} budget ${budget.resetInterval ?? (budget.resetInterval === null ? 'never' : '')}`.trim(),
      compact: typeof usage.limitRemaining === 'number' ? `cap ${usage.limitRemaining.toFixed(2)}` : 'not stated',
      source: 'endpoint', observedAtMs: usage.observedAtMs, freshForMs: usageStaleAfterMs(),
    }
  }
  if (typeof usage.limitRemaining === 'number') {
    return {
      state: 'reported',
      display: `${usage.limitRemaining.toFixed(2)} remaining under the key cap`,
      compact: `cap ${usage.limitRemaining.toFixed(2)}`,
      source: 'endpoint',
      observedAtMs: usage.observedAtMs,
      freshForMs: usageStaleAfterMs(),
    }
  }
  if (usage.limit === null) {
    return {
      state: 'unreported',
      reason: 'the key endpoint states no balance for an uncapped key — the OpenRouter dashboard is the view',
      compact: 'not stated',
    }
  }
  return { state: 'unreported', reason: 'the key endpoint stated no cap or balance', compact: 'not stated' }
}

function openrouterResetWords(interval: string | null | undefined, resetsAt?: string | null): string {
  if (interval === null) return 'never resets'
  return [interval, resetsAt ? `resets ${resetsAt}` : undefined].filter(Boolean).join(' · ')
}

function openrouterFigures(usage: OpenrouterKeyUsage | null): UsageFigureView[] {
  if (!usage) return []
  const observedAtMs = usage.observedAtMs
  const stamp = { observedAtMs, source: 'endpoint' as const, freshForMs: usageStaleAfterMs() }
  const figures: UsageFigureView[] = []
  if (usage.usage !== undefined) {
    figures.push({ key: 'credits-all-time', label: 'credits used (all-time)', value: usage.usage.toFixed(2), ...stamp })
  }
  if (usage.usageWeekly !== undefined) {
    figures.push({ key: 'credits-week', label: 'credits used this week', value: usage.usageWeekly.toFixed(2), ...stamp })
  }
  const capReset = openrouterResetWords(usage.limitReset)
  const capLabel = `key cap${capReset ? ` (${capReset})` : ''}`
  if (typeof usage.limitRemaining === 'number') {
    figures.push({ key: 'cap-remaining', label: `remaining under the ${capLabel}`, value: usage.limitRemaining.toFixed(2), ...stamp })
  } else if (usage.limit === null) {
    figures.push({ key: 'cap', label: capLabel, value: 'uncapped', ...stamp })
  }
  const budget = usage.effectiveBudget
  if (budget) {
    const scope = openrouterBudgetLabel(budget.scope)
    const reset = openrouterResetWords(budget.resetInterval, budget.resetsAt)
    figures.push({ key: 'effective-budget', label: `enforced ${scope} budget${reset ? ` (${reset})` : ''}`, value: `$${budget.remainingUsd.toFixed(2)} of $${budget.limitUsd.toFixed(2)} remaining`, ...stamp })
  }
  const free = usage.freeModelDailyRequests
  if (free) figures.push({ key: 'free-model-daily-requests', label: 'free-model requests (daily)', value: free.limit !== null && free.remaining !== null ? `${free.remaining} of ${free.limit} remaining` : `${free.used} used`, ...stamp })
  if (usage.isFreeTier === true) {
    figures.push({ key: 'tier', label: 'account', value: 'free tier', ...stamp })
  }
  return figures
}

export function openrouterUsageView(provider: 'openrouter', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const keyPresent = reads?.openrouterKeyPresent?.() ?? resolveOpenrouterApiKey() !== undefined
  if (!keyPresent) {
    const refused = readMintedOpenrouterKey()?.expiredMessage !== undefined
    return {
      provider, sourceKind: 'none', label: 'OpenRouter usage', shape: 'none', windows: [], pools: [], spend,
      whyNot: refused ? 'no usable key — the OAuth-minted key was refused; /logins adds OpenRouter' : 'not connected — /logins adds OpenRouter',
      ...(refused ? { readerNote: 'OAuth-minted key refused — no usable key', readerNoteCompact: 'OAuth-minted key refused — no usable key' } : {}),
    }
  }
  const limitedWindow = (reads?.openrouterLimited ?? openrouterLimitWindow)()
  const observed = (reads?.openrouterObserved ?? openrouterObservedKeyUsage)()
  const figures = openrouterFigures(observed.usage)
  const source = observed.errorSource ?? resolveOpenrouterApiKey()?.source
  const slot = source === 'oauth' ? 'OAuth-minted key' : source === 'env' ? 'API key (env)' : 'API key (stored)'
  const readerNote = observed.lastError !== undefined ? `credit truth unavailable for ${slot}` : openrouterLowBalanceNote(observed.usage)
  return {
    provider,
    sourceKind: 'api-key',
    label: 'API usage',
    shape: 'api-spend',
    windows: openrouterObservedWindowViews(reads),
    pools: [],
    credits: openrouterCredits(observed),
    spend,
    tier: API_BILLING_TIER,
    ...(figures.length > 0 ? { figures } : {}),
    ...(readerNote !== undefined
      ? { readerNote, readerNoteCompact: readerNote }
      : observed.usage !== null && figures.length === 0
        ? { readerNote: 'the key endpoint stated no credit facts' }
        : {}),
    ...(limitedWindow.state === 'limited'
      ? { limited: { resetsAtMs: limitedWindow.resetsAtMs } }
      : {}),
  }
}
