// THE BOUNDED-PREVIEW LAW, shared across consent cards. An over-viewport
// consent card is broken twice over: (1) it pushes its own Yes/No options and
// the composer off the pane, so a blind ↵ answers a question the operator
// never saw (the MGR-1 stranding class); (2) its CLOSE is a one-frame content
// shrink taller than the live region, which crosses the inline writer's
// print-once flush line and forces the epoch repaint — the reprinted band is
// the operator's "the same tool call twice / the edit deducted twice"
// sighting (frame-writer.ts inlineEpochRepaint: duplication is the epoch's
// documented cost, so the card must never make an epoch necessary). The
// preview therefore spends viewport-derived rows, the cut is NAMED (an
// honest "+N more" tail), and the full body is one explicit chord away
// (confirm:toggleFullPreview). The Write/create card carried this law first
// (operator live-drive, block G); this module is the one home so the Edit
// and sed cards ride the same bound instead of a divergent copy.

import type { StructuredPatchHunk } from '../../utils/diff.js'

/** Rows a consent card spends around its preview: title + subtitle + borders
 *  + question + the options select + footer hints. */
export const CARD_CHROME_ROWS = 18
export const MIN_PREVIEW_ROWS = 6

/** The preview's row budget for one terminal height: the viewport minus the
 *  card's chrome, floored so a tiny pane still shows something. */
export function consentDiffBudget(terminalRows: number): number {
  return Math.max(MIN_PREVIEW_ROWS, terminalRows - CARD_CHROME_ROWS)
}

/** The preview truncation verdict for one row budget: which rows show and
 *  how many are held back. Pure — the prover pins it. */
export function boundedPreviewPlan(
  totalRows: number,
  budget: number,
  expanded: boolean,
): { shown: number; hidden: number } {
  if (expanded || totalRows <= budget) return { shown: totalRows, hidden: 0 }
  return { shown: budget, hidden: totalRows - budget }
}

/** Bound a hunk list to `shown` lines at LINE granularity (a full-file
 *  overwrite is one monster hunk — hunk-level slicing alone would not bound
 *  it). Order preserved; the boundary hunk is cut, later hunks dropped. */
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

/** Total preview rows a hunk list would spend. */
export function totalHunkRows(hunks: StructuredPatchHunk[]): number {
  return hunks.reduce((n, h) => n + h.lines.length, 0)
}
