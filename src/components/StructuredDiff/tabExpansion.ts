import { expandTabs } from '../../ink/tabstops.js'
import type { StructuredPatchHunk } from '../../utils/diff.js'

const expandedPatches = new WeakMap<StructuredPatchHunk, StructuredPatchHunk>()

function expandLine(line: string): string {
  if (!line.includes('\t')) return line
  const first = line[0]
  if (first === '+' || first === '-' || first === ' ') return first + expandTabs(line.slice(1))
  return expandTabs(line)
}

export function expandPatchTabs(patch: StructuredPatchHunk): StructuredPatchHunk {
  if (!patch.lines.some(line => line.includes('\t'))) return patch
  const cached = expandedPatches.get(patch)
  if (cached) return cached
  const expanded: StructuredPatchHunk = { ...patch, lines: patch.lines.map(expandLine) }
  expandedPatches.set(patch, expanded)
  return expanded
}
