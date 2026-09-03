// contextFill — the ONE derivation every context-fill surface reads.
//
// The rail's ctx line, the deck row, contextGauge (/status, fullscreen),
// the /model header gauge and the /context headline all answer "how full is
// the window" from THIS view, so they agree with each other and with the
// compaction trigger to the token: the numerator is contextFill (tokens.ts —
// the trigger's own count) and the denominator is resolveContextWindow
// (capabilities.ts — the one window owner), both re-derived per read.

import { getSdkBetas } from '../bootstrap/state.js'
import { calculateTokenWarningState, getAutoCompactThreshold, isAutoCompactEnabled } from '../services/compact/autoCompact.js'
import type { Message } from '../types/message.js'
import { contextFillPercent } from './context.js'
import { type ContextResolution, resolveContextWindow } from './model/capabilities.js'
import { contextFill } from './tokens.js'

export interface ContextFillView {
  /** The compaction trigger's own token count; null before any response. */
  usedTokens: number | null
  usedPct: number | null
  /** Where the count came from: wire usage, or a character estimate. */
  fillSource: 'usage' | 'estimate' | null
  window: number
  /** How the window was decided; 'fallback' is the labelled conservative
   *  default, never a stated figure. */
  windowSource: ContextResolution['source']
  windowReason?: string
  /** The autocompact threshold as a percent of the same window; null when
   *  autocompact is off. */
  compactAtPct: number | null
  /** The room left until the fold fires, as a percent of the SAME window
   *  (the warning line's number): usedPct + leftUntilCompactPct is
   *  compactAtPct, to the rounding. Null when autocompact is off or the
   *  count is unknown. */
  leftUntilCompactPct: number | null
}

/**
 * The fill of `model`'s window over `messages`. A transcript with no
 * response yet reads as unknown (null count and percent) rather than an
 * estimate of the prompt alone — the honest "fresh session" state; once a
 * response exists without wire usage the estimate is reported, labelled.
 */
export function contextFillView(messages: readonly Message[], model: string): ContextFillView {
  const resolution = resolveContextWindow(model, getSdkBetas())
  const window = resolution.effectiveWindow
  // The SEATED model arms the fill's switch fence: a usage anchor from a
  // model of another family is dead, and the count estimates until this
  // model answers — the gauge never reads a previous model's usage against
  // the current model's window.
  const fill = contextFill(messages, model)
  const hasResponse = messages.some(message => message.type === 'assistant')
  const usedTokens = fill.source === 'usage' || hasResponse ? fill.tokens : null
  const { used } = contextFillPercent(usedTokens, window)
  let compactAtPct: number | null = null
  let leftUntilCompactPct: number | null = null
  try {
    if (isAutoCompactEnabled() && window > 0) {
      compactAtPct = Math.min(100, (getAutoCompactThreshold(model) / window) * 100)
      // The warning line's own number, from the one owner of the ladder —
      // measured over this same window, so it and usedPct always add up.
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

/** The compact window label a rail paints: the size in k, prefixed `~`
 *  when the window is the labelled conservative default. */
export function contextWindowLabel(window: number, windowSource: ContextResolution['source'] | null): string {
  if (!(window > 0)) return '—'
  return `${windowSource === 'fallback' ? '~' : ''}${Math.round(window / 1000)}k`
}

/** The percent a rail paints: `≈` marks a character estimate. */
export function contextPercentLabel(usedPct: number | null, fillSource: 'usage' | 'estimate' | null): string {
  if (usedPct === null) return '—'
  return `${fillSource === 'estimate' ? '≈' : ''}${Math.round(usedPct)}%`
}
