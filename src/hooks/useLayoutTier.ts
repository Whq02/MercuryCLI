/**
 * useLayoutTier — ONE named layout-tier vocabulary for the TUI chrome
 * (HANDOFF-REACTIVE-SUBSTRATE Phase 3d).
 *
 * Before: 64/80/90/100/110/120 breakpoints were scattered as bare integer
 * comparisons (MercuryFrame 64/80/90/100, DeckPane 100, Deck 110, FleetMonitor
 * 120, FullscreenLayout's ≥100 cockpit gate) with no shared names, and
 * FullscreenLayout read its chrome gates ONCE at module load — so the cockpit /
 * deck could not be toggled in-session.
 *
 * Now: the numbers live here, named; {@link computeChromeMode} decides the
 * chrome (inline / deck-strip / cockpit) from the REAL terminal width reading
 * the gates LIVE (in-session toggles work — the Phase 4 registry backs the
 * gates themselves); {@link useLayoutTier} gives components the named tier
 * flags for their CONTEXT width.
 *
 * THE TerminalSizeContext-OVERRIDE TRAP, resolved by construction: in cockpit
 * mode FullscreenLayout re-provides the size context as the NARROWED center
 * column. A component sizing itself inside that column (MercuryFrame's shed,
 * Deck's two-col split) must use the CONTEXT width — that's what it has to lay
 * out in — so useLayoutTier reads useTerminalSize() (context-aware) for the
 * tier flags. Only the GLOBAL chrome decision must never see the override;
 * that decision (computeChromeMode) is made ABOVE the provider in
 * FullscreenLayout from the real width, and nothing below needs to re-derive
 * it (CockpitActiveContext already carries the answer).
 */

import { isDeckPaneEnabled, isFullscreenEnvEnabled, isHelmHomeEnabled } from '../utils/fullscreen.js'
import { HELM_HOME_MIN_COLS } from '../utils/helmGeometry.js'
import { useTerminalSize } from './useTerminalSize.js'

/** The canonical chrome/shedding breakpoints (columns). Fold-only: these are
 *  the exact values the scattered comparisons used — no retuning. */
export const LAYOUT_BREAKPOINTS = {
  /** Below this the frame drops its quota row entirely (MercuryFrame). */
  frameQuotaMin: 64,
  /** Below this: number-only gauges, 8-char branch (MercuryFrame). */
  compactMax: 80,
  /** Frame behavior chips appear at/above this (MercuryFrame). */
  behaviorChipsMin: 90,
  /** The Helm cockpit home threshold + the frame's 7d gauge + DeckPane's
   *  two-region row. Single source: helmGeometry's HELM_HOME_MIN_COLS. */
  cockpitMin: HELM_HOME_MIN_COLS,
  /** Deck (/deck view) two-column split. */
  deckTwoColMin: 110,
  /** FleetMonitor side-by-side split. 118, not 120: when a command claims the
   *  cockpit the modal's inner content sits inside ~2 cols of chrome, so at a
   *  120-col terminal the split must engage with a couple columns of slack.
   *  (The vehicle is plain useTerminalSize — the claim path provides the FULL
   *  width; audit U1 corrected the earlier ModalContext rationale.) */
  fleetSideBySideMin: 118,
  /** HEIGHT floors: chrome must shed
   *  by ROWS too. Below deckMinRows the 7-row deck strip cannot coexist with
   *  the prompt + statusbar + an open suggestion menu — the input line itself
   *  was pushed off-screen (baseline: render-footer-suggestions.tsx pre-fix).
   *  The cockpit's rails + hero need more still. Below the floor each mode
   *  falls to the next: cockpit → deck-strip → inline. */
  deckMinRows: 22,
  cockpitMinRows: 26,
} as const

export type ChromeMode = 'inline' | 'deck-strip' | 'cockpit'

/**
 * The GLOBAL chrome decision from the REAL terminal width. Reads the gates
 * LIVE on every call (no module-load freeze — /cockpit-style toggles apply on
 * the next render).
 */
export function computeChromeMode(
  realColumns: number,
  realRows?: number,
): ChromeMode {
  if (!isFullscreenEnvEnabled()) return 'inline'
  // Height shed: rows are optional so existing width-only callers keep their
  // behavior on tall terminals; layout-owning callers pass rows so the deck /
  // cockpit chrome collapses instead of eating the prompt on short ones.
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

/** The cockpit boundary's exit band: once the cockpit
 *  is engaged it survives a shrink to cockpitMin−HYST; it disengages below
 *  that. A one-column wobble or a transient terminal size report at the
 *  99/100 boundary can never flap the whole chrome (rails mount/unmount,
 *  transcript rewrap) per event — the same doctrine as railPlan's wide-tier
 *  latch (helmGeometry, 150/144). */
const COCKPIT_EXIT_HYST_COLS = 3
let cockpitLatched = false

/** Test/proof seam: put the chrome latch back to its boot state. */
export function resetChromeModeLatchForTests(): void {
  cockpitLatched = false
}

/**
 * The LIVE chrome decision for LAYOUT OWNERS (FullscreenLayout) — pure
 * {@link computeChromeMode} behind the one cockpit hysteresis latch.
 * Callers that pass CONTEXT-narrowed widths (the footer reserve heuristic)
 * must keep using the pure function: the latch is keyed to the REAL width
 * and a narrowed reading would corrupt it.
 */
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
  // Latched: hold the cockpit through the exit band (width wobble only —
  // a rows/gate change disengages immediately via the pure decision).
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
  /** CONTEXT width — the space this component actually lays out in. */
  columns: number
  rows: number
  /** MercuryFrame vocabulary. */
  showFrameQuota: boolean
  numberOnlyGauges: boolean
  showBehaviorChips: boolean
  show7dGauge: boolean
  branchMax: number
  /** Command-surface splits. */
  deckTwoCol: boolean
  fleetSideBySide: boolean
}

/** Named tier flags for the current (context-aware) width. */
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
