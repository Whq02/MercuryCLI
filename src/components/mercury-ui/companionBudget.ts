
import { displayWidth } from './glyphs.js'

export const DECK_ROW_LINE_CAP = 64
export const BUBBLE_MAX = 44
const STRIP_CHROME = 4
const DOCK_ART_COLUMN = 14
const BUBBLE_CHROME = 5
const BERTH_CHROME = 44
const MINI_ROW_CHROME = 24
export const MINI_BUBBLE_MIN_COLS = 46

export function deckRowLineBudget(cols: number, creatureName: string): number {
  const inner = cols - STRIP_CHROME
  return Math.max(0, Math.min(DECK_ROW_LINE_CAP, inner - 1 - 1 - displayWidth(creatureName) - 3 - 2))
}

export function dockLineBudget(cols: number): number {
  return Math.max(0, cols - STRIP_CHROME - DOCK_ART_COLUMN - 2)
}

export function heroBubbleLineBudget(cols: number): number {
  return Math.max(0, Math.min(BUBBLE_MAX, cols - BERTH_CHROME - BUBBLE_CHROME))
}

export function miniBubbleLineBudget(cols: number): number {
  if (cols < MINI_BUBBLE_MIN_COLS) return Math.max(0, cols - 2)
  return Math.max(0, Math.min(BUBBLE_MAX, cols - MINI_ROW_CHROME - BUBBLE_CHROME))
}

export function fitsBudget(line: string, cells: number): boolean {
  return displayWidth(line) <= cells
}
