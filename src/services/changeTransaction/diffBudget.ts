// ============================================================================
//  changeTransaction/diffBudget — the ONE bounded structured-diff builder
// Moved here from structure/transform.ts (which re-exports it
//  unchanged) so the change-set core, the structural plane, and the LSP
//  change views all cut their rendered diffs through the SAME budget law:
//  a cut is NAMED (omittedHunks), never silent — silent truncation reads as
//  "covered everything".
// ============================================================================

import { structuredPatch } from 'diff'

export interface BoundedDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** The default per-call rendered-line budget. */
export const HUNK_LINE_BUDGET = 80

/**
 * Real diff hunks for the inline change view, computed at BUILD time (the
 * producer holds both texts; renderers never re-read files). Bounded by a
 * line budget — the FIRST hunk gets no exemption (closing verify-wave
 * finding: a whole-file rewrite once shipped an unbounded hunk into the
 * persisted output): oversized hunks truncate within the room and the cut
 * is counted.
 */
export function buildDiffHunks(
  file: string,
  oldText: string,
  newText: string,
  lineBudget: number = HUNK_LINE_BUDGET,
): { hunks: BoundedDiffHunk[]; omittedHunks: number } {
  const patch = structuredPatch(file, file, oldText, newText, undefined, undefined, { context: 2 })
  const hunks: BoundedDiffHunk[] = []
  let budget = 0
  let omitted = 0
  for (const h of patch.hunks) {
    if (budget >= lineBudget) {
      omitted++
      continue
    }
    const room = lineBudget - budget
    if (h.lines.length > room) {
      hunks.push({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: h.lines.slice(0, room),
      })
      budget += room
      omitted++
      continue
    }
    hunks.push({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    })
    budget += h.lines.length
  }
  return { hunks, omittedHunks: omitted }
}
