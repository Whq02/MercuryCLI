import { formatResetTime } from '../../utils/format.js'
import { currentLimits, type ClaudeAILimits } from '../claudeAiLimits.js'
import { rateLimitWindowName } from '../rateLimitMessages.js'
import { providerDisplayName } from './routeLaw.js'
import { activeSourceUsage, bindingWindowOf, type ActiveUsageReads, type UsageWindowView } from './providerUsage.js'
import { getMainLoopModel } from '../../utils/model/model.js'

import { FIRST_WARNING_PCT, SECOND_WARNING_PCT, usageWarningTier, type UsageWarningTier } from './usageTiers.js'
export { FIRST_WARNING_PCT, SECOND_WARNING_PCT, APPROACHING_LIMIT_PCT, usageWarningTier, usageWindowState, type UsageWarningTier } from './usageTiers.js'

export interface ProviderLimitWarningView {
  provider: string
  text: string
  key?: string
}

export interface ProviderLimitWarningFacts {
  view: ProviderLimitWarningView
  windowKey: string
  windowName: string
  pct: number
  tier?: UsageWarningTier
  resetsAtSeconds?: number
}

export interface LimitWarningReads extends ActiveUsageReads {
  anthropicLimits?: () => ClaudeAILimits
}

export function usageWarningNoticeText(text: string, pct: number): string {
  if (pct === 0) return `Usage limit near — ${text}. The provider stops this session when the window is used up. Finish the step in hand, commit what is done, and write down where the work stands before the stop; start nothing that cannot be saved in time.`
  const fact = `Usage limit near — ${text}. The provider stops this session only when the window is used up.`
  return usageWarningTier(pct) === SECOND_WARNING_PCT
    ? `${fact} Keep the work resumable: finish the step in hand; commit what is done and write down where it stands.`
    : fact
}

function warningFacts(provider: string, label: string, pct: number, windowKey: string, windowName: string, resetsAtSeconds?: number): ProviderLimitWarningFacts | null {
  const tier = usageWarningTier(pct)
  if (tier === null) return null
  const reset = formatResetTime(resetsAtSeconds)
  return {
    view: {
      provider,
      text: `${label}: ${pct}% of the ${windowName} used${reset !== undefined ? ` · resets ${reset}` : ''}`,
      key: `${provider}|${windowKey}|${resetsAtSeconds ?? ''}|${tier}`,
    },
    windowKey,
    windowName,
    pct,
    tier,
    ...(resetsAtSeconds !== undefined ? { resetsAtSeconds } : {}),
  }
}

function anthropicWarning(limits: ClaudeAILimits): ProviderLimitWarningFacts | null {
  if (limits.isUsingOverage) {
    return limits.overageStatus === 'allowed_warning' ? {
      view: { provider: 'anthropic', text: 'Anthropic says this account is close to its extra usage spending limit' },
      windowKey: 'overage',
      windowName: 'extra usage spending limit',
      pct: 0,
    } : null
  }
  if (limits.status === 'rejected' || limits.utilization === undefined || limits.rateLimitType === undefined || (limits.resetsAt !== undefined && limits.resetsAt * 1000 <= Date.now())) return null
  return warningFacts('anthropic', providerDisplayName('anthropic'), Math.floor(limits.utilization * 100), limits.rateLimitType, rateLimitWindowName(limits.rateLimitType), limits.resetsAt)
}

export function providerLimitWarningFacts(opts?: {
  model?: string
  reads?: LimitWarningReads
}): ProviderLimitWarningFacts | null {
  const reads = opts?.reads
  let view: ReturnType<typeof activeSourceUsage>
  try {
    view = activeSourceUsage({
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(reads !== undefined ? { reads } : {}),
    })
  } catch {
    return null
  }
  const now = Date.now()
  if (view.limited !== undefined && view.limited.resetsAtMs > now) return null
  const notExpired = (window: UsageWindowView): boolean => window.resetsAtMs === undefined || window.resetsAtMs > now
  const binding = bindingWindowOf({ ...view, windows: view.windows.filter(notExpired), pools: view.pools.filter(notExpired) }, opts?.model ?? getMainLoopModel())
  const label = view.label
  const word = label.endsWith(' usage') && label !== 'API usage'
    ? label.slice(0, -' usage'.length)
    : providerDisplayName(view.provider)
  const fromMeter = binding === undefined ? null : warningFacts(
    view.provider,
    word,
    flooredPct(binding.window),
    binding.claim ?? binding.window.key,
    binding.claim !== undefined ? rateLimitWindowName(binding.claim) : binding.windowName,
    resetSecondsOf(binding.window),
  )
  if (view.provider !== 'anthropic') return fromMeter
  if (view.shape !== 'subscription-windows') return null
  const limits = reads?.anthropicLimits?.() ?? currentLimits
  if (limits.isUsingOverage) return anthropicWarning(limits)
  if (limits.status === 'rejected' && (limits.resetsAt === undefined || limits.resetsAt * 1000 > now)) return null
  const fromHeaders = anthropicWarning(limits)
  if (fromMeter === null) return fromHeaders
  return fromHeaders !== null && fromHeaders.pct > fromMeter.pct ? fromHeaders : fromMeter
}

export function providerLimitWarning(opts?: {
  model?: string
  reads?: LimitWarningReads
}): ProviderLimitWarningView | null {
  return providerLimitWarningFacts(opts)?.view ?? null
}

export function usageWarningEmissionKey(warning: ProviderLimitWarningView): string | null {
  if (warning.key !== undefined) return warning.key
  const match = /: (\d+)% of (?:the )?(.+)/.exec(warning.text)
  if (match === null) return `${warning.provider}|${warning.text}`
  const tier = usageWarningTier(Number(match[1]))
  return tier === null ? null : `${warning.provider}|${match[2]}|${tier}`
}

export function takeUsageWarning(seen: Set<string>, warning: ProviderLimitWarningView | null): boolean {
  if (warning === null) return false
  const key = usageWarningEmissionKey(warning)
  if (key === null || seen.has(key)) return false
  seen.add(key)
  if (key.endsWith(`|${SECOND_WARNING_PCT}`)) seen.add(`${key.slice(0, key.lastIndexOf('|'))}|${FIRST_WARNING_PCT}`)
  return true
}

export function preferSessionLimitWarning(
  fromSession: ProviderLimitWarningView | null | undefined,
  local: ProviderLimitWarningView | null,
): ProviderLimitWarningView | null {
  return fromSession ?? local
}

function flooredPct(view: UsageWindowView): number {
  return Math.floor(Math.min(100, Math.max(0, view.usedPct ?? 0)))
}

function resetSecondsOf(view: UsageWindowView): number | undefined {
  return view.resetsAtMs !== undefined ? Math.floor(view.resetsAtMs / 1000) : undefined
}
