import { formatResetTime } from '../../utils/format.js'
import { currentLimits, type ClaudeAILimits, type RateLimitType } from '../claudeAiLimits.js'
import { rateLimitWindowName } from '../rateLimitMessages.js'
import { providerDisplayName } from './routeLaw.js'
import {
  activeSourceUsage,
  anthropicPoolWindowViews,
  type ActiveUsageReads,
  type UsageWindowView,
} from './providerUsage.js'

export const APPROACHING_LIMIT_PCT = 70

export interface ProviderLimitWarningView {
  provider: string
  text: string
}

export interface LimitWarningReads extends ActiveUsageReads {
  anthropicLimits?: () => ClaudeAILimits
}

function windowWord(view: UsageWindowView): string {
  if (view.key === 'cap' || view.label === 'cap') return 'credit cap'
  if (view.label === 'quota') return 'quota'
  if (view.label === 'wk') return 'weekly window'
  if (view.label === 'win') return 'usage window'
  return `${view.label} window`
}

function resetTail(epochSeconds: number | undefined): string {
  const rendered = formatResetTime(epochSeconds)
  return rendered !== undefined ? ` · resets ${rendered}` : ''
}

function composeLine(provider: string, pct: number, window: string, resetsAtSeconds?: number): string {
  return `${provider}: ${pct}% of ${window} used${resetTail(resetsAtSeconds)}`
}

function anthropicWarning(limits: ClaudeAILimits): ProviderLimitWarningView | null {
  const provider = providerDisplayName('anthropic')
  if (limits.isUsingOverage) {
    if (limits.overageStatus === 'allowed_warning') {
      return {
        provider: 'anthropic',
        text: 'Anthropic says this account is close to its extra usage spending limit',
      }
    }
    return null
  }
  if (limits.status !== 'allowed_warning') return null
  if (limits.utilization !== undefined && limits.utilization < APPROACHING_LIMIT_PCT / 100) return null
  const claim = limits.rateLimitType
  if (claim === undefined) return null
  const window = claim === 'overage' ? 'extra usage limit' : rateLimitWindowName(claim)
  const pct = limits.utilization !== undefined ? Math.floor(limits.utilization * 100) : 0
  const text =
    pct > 0
      ? composeLine(provider, pct, window, limits.resetsAt)
      : `${provider}: approaching ${window}${resetTail(limits.resetsAt)}`
  return { provider: 'anthropic', text }
}

export function providerLimitWarning(opts?: {
  model?: string
  reads?: LimitWarningReads
}): ProviderLimitWarningView | null {
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

  if (view.provider === 'anthropic') {
    if (view.shape !== 'subscription-windows') return null
    const limits = reads?.anthropicLimits?.() ?? currentLimits
    const fromHeaders = anthropicWarning(limits)
    if (fromHeaders !== null) return fromHeaders
    const meterWorst = worstLiveWindow([...view.windows, ...anthropicPoolWindowViews(reads)])
    if (meterWorst === null) return null
    const pct = flooredPct(meterWorst)
    if (pct < APPROACHING_LIMIT_PCT) return null
    const window = rateLimitWindowName(anthropicClaimOf(meterWorst))
    return {
      provider: 'anthropic',
      text: composeLine(providerDisplayName('anthropic'), pct, window, resetSecondsOf(meterWorst)),
    }
  }

  const worst = worstLiveWindow(view.windows)
  if (worst === null) return null
  const pct = flooredPct(worst)
  if (pct < APPROACHING_LIMIT_PCT) return null
  const label = view.label
  const word =
    label.endsWith(' usage') && label !== 'API usage'
      ? label.slice(0, -' usage'.length)
      : providerDisplayName(view.provider)
  return {
    provider: view.provider,
    text: composeLine(word, pct, windowWord(worst), resetSecondsOf(worst)),
  }
}

export function preferSessionLimitWarning(
  fromSession: ProviderLimitWarningView | null | undefined,
  local: ProviderLimitWarningView | null,
): ProviderLimitWarningView | null {
  return fromSession ?? local
}

function anthropicClaimOf(view: UsageWindowView): RateLimitType {
  if (view.key === '5h') return 'five_hour'
  if (view.key === '7d') return 'seven_day'
  return view.key as RateLimitType
}

function worstLiveWindow(windows: UsageWindowView[]): UsageWindowView | null {
  const live = windows.filter(
    w => w.state === 'live' && typeof w.usedPct === 'number' && Number.isFinite(w.usedPct),
  )
  if (live.length === 0) return null
  return live.reduce((a, b) => ((b.usedPct ?? 0) > (a.usedPct ?? 0) ? b : a))
}

function flooredPct(view: UsageWindowView): number {
  return Math.floor(Math.min(100, Math.max(0, view.usedPct ?? 0)))
}

function resetSecondsOf(view: UsageWindowView): number | undefined {
  return view.resetsAtMs !== undefined ? Math.floor(view.resetsAtMs / 1000) : undefined
}
