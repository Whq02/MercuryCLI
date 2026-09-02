// ============================================================================
//  mercury-ui/companionBudget — how many cells each companion surface can give
//  a line, at the live terminal size.
//
//  The operator's rule: no tip and no moment line may ever overflow its row —
//  never truncated, never wrapped, never spilled. So a line is chosen to FIT:
//  every mounted surface reports its budget (the row's real width at the
//  current size, less the creature, the name and whatever status the row
//  carries), the engine speaks only lines that fit the NARROWEST mounted
//  surface, and a surface paints a line only when it fits its own budget.
//  These are the pure budget laws the surfaces and the prover share — one
//  number per surface, derived from the same chrome the surface renders.
// ============================================================================

import { displayWidth } from './glyphs.js'

/** The full deck row caps its line here (the row is one line of the strip). */
export const DECK_ROW_LINE_CAP = 64
/** A speech bubble (hero berth · mini critter) caps its line here. */
export const BUBBLE_MAX = 44
/** The deck strip's chrome: a round border (2) + paddingX 1 on each side (2). */
const STRIP_CHROME = 4
/** The mini art column in the compact dock (~13 cells) + its right margin. */
const DOCK_ART_COLUMN = 14
/** A bubble's chrome: the tail (1) + the round border (2) + paddingX 1 (2). */
const BUBBLE_CHROME = 5
/** The berth row's own chrome beside the hero bubble (hero art · card borders · gutters). */
const BERTH_CHROME = 44
/** The mini row's art + flourishes beside its bubble. */
const MINI_ROW_CHROME = 24
/** Below this width the mini bubble folds into a plain caption line. */
export const MINI_BUBBLE_MIN_COLS = 46

/** The full deck row (≥ 100 cols): `glyph name · "line"` inside the strip. */
export function deckRowLineBudget(cols: number, creatureName: string): number {
  const inner = cols - STRIP_CHROME
  // pose glyph (1) + space (1) + name + ' · ' (3) + the two quotes (2)
  return Math.max(0, Math.min(DECK_ROW_LINE_CAP, inner - 1 - 1 - displayWidth(creatureName) - 3 - 2))
}

/** The compact dock's speech line (< 100 cols): `"line"` beside the mini art. */
export function dockLineBudget(cols: number): number {
  return Math.max(0, cols - STRIP_CHROME - DOCK_ART_COLUMN - 2)
}

/** The hero-side bubble in the cockpit berth. */
export function heroBubbleLineBudget(cols: number): number {
  return Math.max(0, Math.min(BUBBLE_MAX, cols - BERTH_CHROME - BUBBLE_CHROME))
}

/** The sub-hero mini critter's bubble, or its caption line below MINI_BUBBLE_MIN_COLS. */
export function miniBubbleLineBudget(cols: number): number {
  if (cols < MINI_BUBBLE_MIN_COLS) return Math.max(0, cols - 2)
  return Math.max(0, Math.min(BUBBLE_MAX, cols - MINI_ROW_CHROME - BUBBLE_CHROME))
}

/** Does `line` fit a budget of `cells`? The one width law every surface uses. */
export function fitsBudget(line: string, cells: number): boolean {
  return displayWidth(line) <= cells
}
