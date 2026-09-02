
import type { StructuredPatchHunk } from '../../utils/diff.js'

export const CARD_CHROME_ROWS = 18
export const MIN_PREVIEW_ROWS = 6

export function consentDiffBudget(terminalRows: number): number {
  return Math.max(MIN_PREVIEW_ROWS, terminalRows - CARD_CHROME_ROWS)
}

export function boundedPreviewPlan(
  totalRows: number,
  budget: number,
  expanded: boolean,
): { shown: number; hidden: number } {
  if (expanded || totalRows <= budget) return { shown: totalRows, hidden: 0 }
  return { shown: budget, hidden: totalRows - budget }
}

export function boundHunksToRows(
  hunks: StructuredPatchHunk[],
  shown: number,
): StructuredPatchHunk[] {
  const kept: StructuredPatchHunk[] = []
  let left = shown
  for (const hunk of hunks) {
    if (left <= 0) break
    if (hunk.lines.length <= left) {
      kept.push(hunk)
      left -= hunk.lines.length
    } else {
      kept.push({ ...hunk, lines: hunk.lines.slice(0, left) })
      left = 0
    }
  }
  return kept
}

export function totalHunkRows(hunks: StructuredPatchHunk[]): number {
  return hunks.reduce((n, h) => n + h.lines.length, 0)
}
