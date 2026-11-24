import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
  EFFORT_XHIGH,
} from '../theme/rowGlyphs.js'
import type { EffortLevel } from '../../models/effort/effort.js'

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
