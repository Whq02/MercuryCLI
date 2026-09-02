// contextGauge — context-window fill from the ONE fill derivation
// (utils/contextFill — the same numerator the compaction trigger reads over
// the same window owner). `live` with a percent once a response exists;
// `unavailable` on a fresh session (no response yet) — never a fake gauge.
//
// The fresh-session reason is EXPORTED (FC-139): it is the gauge's own
// documented NORMAL state — a surface that treats every non-live read as
// degraded must be able to tell this one apart without copying the
// spelling.
import type { Message } from '../../types/message.js'
import { contextFillView, type ContextFillView } from '../contextFill.js'
import type { ModelName } from '../model/model.js'
import { withState, type Snapshot } from './types.js'

export type ContextGaugeData = {
  usedPct: number | null
  window: number
  /** The token figure behind usedPct; null before any response. */
  usedTokens: number | null
  /** 'estimate' when no wire usage exists (a surface labels it). */
  fillSource: ContextFillView['fillSource']
  /** 'fallback' when the window is the labelled conservative default. */
  windowSource: ContextFillView['windowSource']
}

/** The gauge's documented NORMAL pre-usage state (FC-139). */
export const CONTEXT_FRESH_SESSION_REASON = 'fresh session — no usage yet'

export function contextGauge(
  messages: Message[],
  model: ModelName,
): Snapshot<{ data: ContextGaugeData }> {
  try {
    const fill = contextFillView(messages, model)
    const data: ContextGaugeData = {
      usedPct: fill.usedPct,
      window: fill.window,
      usedTokens: fill.usedTokens,
      fillSource: fill.fillSource,
      windowSource: fill.windowSource,
    }
    if (fill.usedPct == null) {
      return withState('unavailable', data, CONTEXT_FRESH_SESSION_REASON, 'contextFill')
    }
    return { state: 'live', source: 'contextFill', data }
  } catch {
    return withState('unavailable', {
      usedPct: null,
      window: 0,
      usedTokens: null,
      fillSource: null,
      windowSource: 'fallback',
    }, 'usage unavailable')
  }
}

// (Usage here is provider-neutral, telemetry-truth lane: every usage
// surface derives
// from providerUsage.activeSourceUsage — the provider-generic owner — and
// the 5h/7d decode itself stays with utils/cockpit/quota's quotaWindows,
// which that owner consumes. A Claude-shaped envelope here would be a second
// owner waiting to disagree.)
