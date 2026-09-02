
import { isDeckPaneEnabled, isFullscreenEnvEnabled, isHelmHomeEnabled } from '../utils/fullscreen.js'
import { VIEWPORT_FLOOR_EXIT_BAND, VIEWPORT_FLOOR_ROWS } from '../ink/viewportFloor.js'
import { HELM_HOME_MIN_COLS } from '../utils/helmGeometry.js'
import { useTerminalSize } from './useTerminalSize.js'

export const LAYOUT_BREAKPOINTS = {
  frameQuotaMin: 64,
  compactMax: 80,
  behaviorChipsMin: 90,
  cockpitMin: HELM_HOME_MIN_COLS,
  deckTwoColMin: 110,
  fleetSideBySideMin: 118,
  deckMinRows: VIEWPORT_FLOOR_ROWS,
  cockpitMinRows: 26,
} as const

export type ChromeMode = 'inline' | 'deck-strip' | 'cockpit'

export function computeChromeMode(
  realColumns: number,
  realRows?: number,
): ChromeMode {
  if (!isFullscreenEnvEnabled()) return 'inline'
  const rows = realRows ?? Number.POSITIVE_INFINITY
  if (
    isHelmHomeEnabled() &&
    realColumns >= LAYOUT_BREAKPOINTS.cockpitMin &&
    rows >= LAYOUT_BREAKPOINTS.cockpitMinRows
  ) {
    return 'cockpit'
  }
  if (rows < LAYOUT_BREAKPOINTS.deckMinRows) return 'inline'
  return isDeckPaneEnabled() ? 'deck-strip' : 'inline'
}

const COCKPIT_EXIT_HYST_COLS = VIEWPORT_FLOOR_EXIT_BAND
let cockpitLatched = false

export function resetChromeModeLatchForTests(): void {
  cockpitLatched = false
}

export function chromeModeLive(
  realColumns: number,
  realRows?: number,
): ChromeMode {
  const pure = computeChromeMode(realColumns, realRows)
  if (pure === 'cockpit') {
    cockpitLatched = true
    return pure
  }
  if (!cockpitLatched) return pure
  const rows = realRows ?? Number.POSITIVE_INFINITY
  const withinBand =
    isFullscreenEnvEnabled() &&
    isHelmHomeEnabled() &&
    rows >= LAYOUT_BREAKPOINTS.cockpitMinRows &&
    realColumns >= LAYOUT_BREAKPOINTS.cockpitMin - COCKPIT_EXIT_HYST_COLS
  if (withinBand) return 'cockpit'
  cockpitLatched = false
  return pure
}

export interface LayoutTier {
  columns: number
  rows: number
  showFrameQuota: boolean
  numberOnlyGauges: boolean
  showBehaviorChips: boolean
  show7dGauge: boolean
  branchMax: number
  deckTwoCol: boolean
  fleetSideBySide: boolean
}

export function useLayoutTier(): LayoutTier {
  const { columns, rows } = useTerminalSize()
  return {
    columns,
    rows,
    showFrameQuota: columns >= LAYOUT_BREAKPOINTS.frameQuotaMin,
    numberOnlyGauges: columns < LAYOUT_BREAKPOINTS.compactMax,
    showBehaviorChips: columns >= LAYOUT_BREAKPOINTS.behaviorChipsMin,
    show7dGauge: columns >= LAYOUT_BREAKPOINTS.cockpitMin,
    branchMax:
      columns < LAYOUT_BREAKPOINTS.compactMax
        ? 8
        : columns < LAYOUT_BREAKPOINTS.cockpitMin
          ? 16
          : 28,
    deckTwoCol: columns >= LAYOUT_BREAKPOINTS.deckTwoColMin,
    fleetSideBySide: columns >= LAYOUT_BREAKPOINTS.fleetSideBySideMin,
  }
}
