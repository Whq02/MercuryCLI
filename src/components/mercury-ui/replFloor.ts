// ============================================================================
//  mercury-ui/replFloor — the Main REPL's finished-floor laws EXTRACTED as
//  shared owners.
//
//  The Coordinator conversation and the attached-session REPL inherit the
//  Main REPL floor through REAL shared owners — never lookalike forks
//  (challenger XC-1: three composers had three identity grammars). This
//  module is the importable seam:
//
//    · composerBorderRole  — the resting/composing border ladder's BASE rungs
// the empty composer rests on the calm structural
//      `promptBorderResting`; the first composed character regains identity
//      via `promptBorder`. PromptInput's own getBorderColor keeps its
//      higher-priority rungs (bash mode, permission-mode tints, teammate
//      colors) and falls through to THIS function — extraction, not a copy.
//
//    · composerBorderStyle — CN-14 law 6: on a critically short terminal the
//      composer frame is decoration and its two border rows are exactly what
//      squeezes the input line out — the border sheds below 14 rows, the
//      ❯ input line survives.
//
//    · WHEEL_STEP_ROWS / pageStepRows — the ONE scroll grammar for the
//      concourse conversation surfaces (challenger CU-11: the page and wheel
//      steps disagreed inside one route family): wheel steps a fixed small
//      constant; page keys move ~a viewport.
// ============================================================================

import type { Theme } from '../../utils/theme.js'

/** CN-14 law 6 floor: below this row count the composer border sheds. */
export const COMPOSER_BORDER_SHED_ROWS = 14

/** The resting/composing base rungs of the Main REPL's border ladder. */
export function composerBorderRole(empty: boolean): keyof Theme {
  return empty ? 'promptBorderResting' : 'promptBorder'
}

/** The CN-14 border shed: no frame below COMPOSER_BORDER_SHED_ROWS rows. */
export function composerBorderStyle(rows: number): 'round' | undefined {
  return rows < COMPOSER_BORDER_SHED_ROWS ? undefined : 'round'
}

/** One wheel step for every concourse conversation surface (CU-11). */
export const WHEEL_STEP_ROWS = 3

/** Page keys move ~a viewport (never a fixed 4-row hop at 50 rows). */
export function pageStepRows(viewportRows: number): number {
  return Math.max(4, viewportRows - 1)
}
