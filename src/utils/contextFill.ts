
import { getSdkBetas } from '../bootstrap/state.js'
import { calculateTokenWarningState, getAutoCompactThreshold, isAutoCompactEnabled } from '../services/compact/autoCompact.js'
import type { Message } from '../types/message.js'
import { contextFillPercent } from './context.js'
import { type ContextResolution, resolveContextWindow } from './model/capabilities.js'
import { contextFill } from './tokens.js'

export interface ContextFillView {
  usedTokens: number | null
  usedPct: number | null
  fillSource: 'usage' | 'estimate' | null
  window: number
  windowSource: ContextResolution['source']
  windowReason?: string
  compactAtPct: number | null
  leftUntilCompactPct: number | null
}

export function contextFillView(messages: readonly Message[], model: string): ContextFillView {
  const resolution = resolveContextWindow(model, getSdkBetas())
  const window = resolution.effectiveWindow
  const fill = contextFill(messages, model)
  const hasResponse = messages.some(message => message.type === 'assistant')
  const usedTokens = fill.source === 'usage' || hasResponse ? fill.tokens : null
  const { used } = contextFillPercent(usedTokens, window)
  let compactAtPct: number | null = null
  let leftUntilCompactPct: number | null = null
  try {
    if (isAutoCompactEnabled() && window > 0) {
      compactAtPct = Math.min(100, (getAutoCompactThreshold(model) / window) * 100)
      if (usedTokens !== null) leftUntilCompactPct = calculateTokenWarningState(usedTokens, model).pctLeft ?? null
    }
  } catch {
    compactAtPct = null
    leftUntilCompactPct = null
  }
  return {
    usedTokens,
    usedPct: used,
    fillSource: usedTokens === null ? null : fill.source,
    window,
    windowSource: resolution.source,
    ...(resolution.fallbackReason ? { windowReason: resolution.fallbackReason } : {}),
    compactAtPct,
    leftUntilCompactPct,
  }
}

export function contextWindowLabel(window: number, windowSource: ContextResolution['source'] | null): string {
  if (!(window > 0)) return '—'
  return `${windowSource === 'fallback' ? '~' : ''}${Math.round(window / 1000)}k`
}

export function contextPercentLabel(usedPct: number | null, fillSource: 'usage' | 'estimate' | null): string {
  if (usedPct === null) return '—'
  return `${fillSource === 'estimate' ? '≈' : ''}${Math.round(usedPct)}%`
}
