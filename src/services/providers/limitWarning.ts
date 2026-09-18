import { formatResetTime } from '../../utils/format.js'
import { currentLimits, type ClaudeAILimits } from '../claudeAiLimits.js'
import { rateLimitWindowName } from '../rateLimitMessages.js'
import { providerDisplayName } from './routeLaw.js'
import { activeSourceUsage, type ActiveUsageReads, type UsageWindowView } from './providerUsage.js'

export const APPROACHING_LIMIT_PCT = 70

export interface ProviderLimitWarningView {
  provider: string
  text: string
}

export interface ProviderLimitWarningFacts {
  view: ProviderLimitWarningView
  windowKey: string
  windowName: string
  pct: number
  resetsAtSeconds?: number
}

export interface LimitWarningReads extends ActiveUsageReads {
  anthropicLimits?: () => ClaudeAILimits
}

function resetTail(epochSeconds: number | undefined): string {
  const rendered = formatResetTime(epochSeconds)
  return rendered !== undefined ? ` · resets ${rendered}` : ''
}

function composeLine(provider: string, pct: number, window: string, resetsAtSeconds?: number): string {
  return `${provider}: ${pct}% of ${window} used${resetTail(resetsAtSeconds)}`
}

function anthropicWarning(limits: ClaudeAILimits): ProviderLimitWarningFacts | null {
  const provider = providerDisplayName('anthropic')
  if (limits.isUsingOverage) {
    if (limits.overageStatus === 'allowed_warning') {
      return {
        view: {
          provider: 'anthropic',
          text: 'Anthropic says this account is close to its extra usage spending limit',
        },
        windowKey: 'overage',
        windowName: 'extra usage spending limit',
        pct: 0,
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
  return {
    view: { provider: 'anthropic', text },
    windowKey: claim,
    windowName: window,
    pct,
    ...(limits.resetsAt !== undefined ? { resetsAtSeconds: limits.resetsAt } : {}),
  }
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

  if (view.provider === 'anthropic') {
    if (view.shape !== 'subscription-windows') return null
    const limits = reads?.anthropicLimits?.() ?? currentLimits
    const fromHeaders = anthropicWarning(limits)
    if (fromHeaders !== null) return fromHeaders
    const binding = view.binding
    if (binding === undefined) return null
    const pct = flooredPct(binding.window)
    if (pct < APPROACHING_LIMIT_PCT) return null
    const window = binding.claim !== undefined ? rateLimitWindowName(binding.claim) : binding.windowName
    const resetsAtSeconds = resetSecondsOf(binding.window)
    return {
      view: {
        provider: 'anthropic',
        text: composeLine(providerDisplayName('anthropic'), pct, window, resetsAtSeconds),
      },
      windowKey: binding.claim ?? binding.window.key,
      windowName: window,
      pct,
      ...(resetsAtSeconds !== undefined ? { resetsAtSeconds } : {}),
    }
  }

  const binding = view.binding
  if (binding === undefined) return null
  const pct = flooredPct(binding.window)
  if (pct < APPROACHING_LIMIT_PCT) return null
  const label = view.label
  const word =
    label.endsWith(' usage') && label !== 'API usage'
      ? label.slice(0, -' usage'.length)
      : providerDisplayName(view.provider)
  const resetsAtSeconds = resetSecondsOf(binding.window)
  return {
    view: {
      provider: view.provider,
      text: composeLine(word, pct, binding.windowName, resetsAtSeconds),
    },
    windowKey: binding.window.key,
    windowName: binding.windowName,
    pct,
    ...(resetsAtSeconds !== undefined ? { resetsAtSeconds } : {}),
  }
}

export function providerLimitWarning(opts?: {
  model?: string
  reads?: LimitWarningReads
}): ProviderLimitWarningView | null {
  return providerLimitWarningFacts(opts)?.view ?? null
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
