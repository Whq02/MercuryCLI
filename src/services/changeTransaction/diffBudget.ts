
import { structuredPatch } from 'diff'

export interface BoundedDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export const HUNK_LINE_BUDGET = 80

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
