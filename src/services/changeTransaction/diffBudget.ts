
import { structuredPatch } from 'diff'

export interface BoundedDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export const HUNK_LINE_BUDGET = 80

export interface BoundedDiff {
  hunks: BoundedDiffHunk[]
  omittedHunks: number
  added: number
  removed: number
}

export function buildDiffHunks(
  file: string,
  oldText: string,
  newText: string,
  lineBudget: number = HUNK_LINE_BUDGET,
): BoundedDiff {
  const patch = structuredPatch(file, file, oldText, newText, undefined, undefined, { context: 2 })
  const hunks: BoundedDiffHunk[] = []
  let budget = 0
  let omitted = 0
  let added = 0
  let removed = 0
  for (const h of patch.hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
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
  return { hunks, omittedHunks: omitted, added, removed }
}
