// Effort-level → glyph mapping plus the effort-changed notification string.
// The glyphs are owned by constants/figures; an unknown level (remote
// configuration can mint values outside the ladder) falls back to the HIGH
// glyph rather than rendering nothing.

import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
  EFFORT_XHIGH,
} from '../constants/figures.js'
import {
  getDisplayedEffortLabel,
  getDisplayedEffortLevel,
  modelSupportsEffort,
  type EffortLevel,
  type EffortValue,
} from '../utils/effort.js'

const SYMBOLS: Record<EffortLevel, string> = {
  low: EFFORT_LOW,
  medium: EFFORT_MEDIUM,
  high: EFFORT_HIGH,
  xhigh: EFFORT_XHIGH,
  max: EFFORT_MAX,
}

export function effortLevelToSymbol(level: EffortLevel): string {
  return SYMBOLS[level] ?? EFFORT_HIGH
}

/** The effort-changed notification: undefined when the model has no effort
 *  axis; otherwise the glyph, the TRUTHFUL label (which may be an
 *  out-of-ladder provider tier or an honest "default"), and the command that
 *  changes it. */
export function getEffortNotificationText(
  effortValue: EffortValue | undefined,
  model: string,
): string | undefined {
  if (!modelSupportsEffort(model)) return undefined
  const label = getDisplayedEffortLabel(model, effortValue)
  // Both halves from the RESOLUTION, as the standing chip does: the glyph
  // was indexed by the raw request, so /effort max on a model whose
  // ceiling is high rendered the max glyph beside the word high
  // (FN-018 rank 23).
  const symbol = SYMBOLS[getDisplayedEffortLevel(model, effortValue)] ?? EFFORT_HIGH
  return `${symbol} effort: ${label} · /effort to change`
}
