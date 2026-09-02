
import type { ParsedInput, ParsedKey } from '../input/input-decoder.js'

export const ALTERNATE_SCROLL_POLICY = 'scroll-first-in-native-selection' as const

export interface AlternateScrollState {
  altScreenActive: boolean
  mouseTrackingEnabled: boolean
  elevatedSurfaceActive: boolean
}

const isPlainArrow = (i: ParsedInput): i is ParsedKey =>
  i.kind === 'key' &&
  (i.name === 'up' || i.name === 'down') &&
  !i.ctrl &&
  !i.meta &&
  !i.shift &&
  !i.option

export function resolveAlternateScrollIntent(
  items: readonly ParsedInput[],
  state: AlternateScrollState,
): ParsedInput[] {
  const engaged =
    state.altScreenActive && !state.mouseTrackingEnabled && !state.elevatedSurfaceActive
  if (!engaged) return [...items]
  return items.map(i =>
    isPlainArrow(i) ? { ...i, name: i.name === 'up' ? 'wheelup' : 'wheeldown' } : i,
  )
}
