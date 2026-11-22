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
import { notBuilt } from '../pi/holes.js'

const SYMBOLS: Record<EffortLevel, string> = {
  low: EFFORT_LOW,
  medium: EFFORT_MEDIUM,
  high: EFFORT_HIGH,
  xhigh: EFFORT_XHIGH,
  max: EFFORT_MAX,
}

export function effortLevelToSymbol(level: EffortLevel): string {
  return notBuilt('src/components/EffortIndicator.ts:25')
}

export function getEffortNotificationText(
  effortValue: EffortValue | undefined,
  model: string,
): string | undefined {
  return notBuilt('src/components/EffortIndicator.ts:29')
}
