
import type { ParsedInput, ParsedKey } from '../input/input-decoder.js'

export const ALTERNATE_SCROLL_POLICY = 'scroll-first-in-native-selection' as const

interface AlternateScrollState {
  altScreenActive: boolean
  mouseTrackingEnabled: boolean
  elevatedSurfaceActive: boolean
  arrowKeysOwned?: boolean
  platform?: string
  wheelReportingConfirmed?: boolean
  scrollableTranscript?: boolean
}

const isPlainArrow = (i: ParsedInput): i is ParsedKey =>
  i.kind === 'key' &&
  (i.name === 'up' || i.name === 'down') &&
  !i.ctrl &&
  !i.meta &&
  !i.shift &&
  !i.option &&
  !i.super &&
  !i.fn &&
  !i.isPasted

export function resolveAlternateScrollIntent(
  items: readonly ParsedInput[],
  state: AlternateScrollState,
): ParsedInput[] {
  const unconfirmedWindowsWheel =
    (state.platform ?? process.platform) === 'win32' &&
    !state.wheelReportingConfirmed && state.scrollableTranscript === true
  const engaged =
    state.altScreenActive && !state.elevatedSurfaceActive && state.arrowKeysOwned !== true &&
    (!state.mouseTrackingEnabled || unconfirmedWindowsWheel)
  if (!engaged) return [...items]
  return items.map(i =>
    isPlainArrow(i) ? { ...i, name: i.name === 'up' ? 'wheelup' : 'wheeldown' } : i,
  )
}
