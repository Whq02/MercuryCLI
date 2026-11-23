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

export function getEffortNotificationText(
  effortValue: EffortValue | undefined,
  model: string,
): string | undefined {
  if (!modelSupportsEffort(model)) return undefined
  const label = getDisplayedEffortLabel(model, effortValue)
  const level = getDisplayedEffortLevel(model, effortValue)
  return `${effortLevelToSymbol(level)} effort: ${label} · /effort to change`
}
