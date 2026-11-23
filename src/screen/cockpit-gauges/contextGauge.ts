import type { Message } from '../../engine/message-shapes/message.js'
import { contextFillView, type ContextFillView } from '../../engine/context-window/contextFill.js'
import type { ModelName } from '../../models/catalogue/engineModel.js'
import { withState, type Snapshot } from '../cockpit/types.js'

export type ContextGaugeData = {
  usedPct: number | null
  window: number
  usedTokens: number | null
  fillSource: ContextFillView['fillSource']
  windowSource: ContextFillView['windowSource']
}

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

