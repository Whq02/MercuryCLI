
import type { StructuredPatchHunk } from '../../utils/diff.js'

export const DIFF_LINE_RENDER_CAP = 2000

export const DIFF_LINE_MARKER_SLACK = 64

const boundedPatches = new WeakMap<StructuredPatchHunk, StructuredPatchHunk>()

function boundLine(line: string): string {
  if (line.length <= DIFF_LINE_RENDER_CAP) return line
  const omitted = line.length - DIFF_LINE_RENDER_CAP
  return `${line.slice(0, DIFF_LINE_RENDER_CAP)} …[+${omitted.toLocaleString('en-US')} chars — the full line is in the file]`
}

export function boundPatchForRender(patch: StructuredPatchHunk): StructuredPatchHunk {
  if (!patch.lines.some(line => line.length > DIFF_LINE_RENDER_CAP)) return patch
  const cached = boundedPatches.get(patch)
  if (cached) return cached
  const bounded: StructuredPatchHunk = { ...patch, lines: patch.lines.map(boundLine) }
  boundedPatches.set(patch, bounded)
  return bounded
}
