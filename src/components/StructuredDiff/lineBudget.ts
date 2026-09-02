// The render-time budget on one diff line. A single pathological line — a
// base64 blob, a minified bundle, a generated lockfile row — otherwise
// reaches the highlighter and the wrap pass whole, turns into tens of
// thousands of terminal rows, and stalls every frame the transcript paints
// while the hunk is visible. The budget is RENDER-ONLY: the file keeps the
// full bytes, and the elision marker names the count it cut.
//
// One seam: every diff surface (transcript rows, the diff detail view, the
// permission-prompt preview) renders through StructuredDiff, which applies
// this bound before its highlighter and its fallback alike.
// prove-diff-line-budget pins the law.

import type { StructuredPatchHunk } from '../../utils/diff.js'

/** Characters of one diff line that reach the renderer. Wide terminals wrap
 *  this into a handful of rows; the marker carries the honest remainder. */
export const DIFF_LINE_RENDER_CAP = 2000

/** The marker slack: a bounded line may exceed the cap by at most this many
 *  marker characters. Exported for the prover's ceiling assert. */
export const DIFF_LINE_MARKER_SLACK = 64

const boundedPatches = new WeakMap<StructuredPatchHunk, StructuredPatchHunk>()

function boundLine(line: string): string {
  if (line.length <= DIFF_LINE_RENDER_CAP) return line
  const omitted = line.length - DIFF_LINE_RENDER_CAP
  // The structural first column (+/-/space) sits inside the kept head.
  return `${line.slice(0, DIFF_LINE_RENDER_CAP)} …[+${omitted.toLocaleString('en-US')} chars — the full line is in the file]`
}

/** The identity fast path returns the SAME object for an in-budget hunk (the
 *  per-hunk render cache keys on object identity); an over-budget hunk maps
 *  to one stable bounded twin. */
export function boundPatchForRender(patch: StructuredPatchHunk): StructuredPatchHunk {
  if (!patch.lines.some(line => line.length > DIFF_LINE_RENDER_CAP)) return patch
  const cached = boundedPatches.get(patch)
  if (cached) return cached
  const bounded: StructuredPatchHunk = { ...patch, lines: patch.lines.map(boundLine) }
  boundedPatches.set(patch, bounded)
  return bounded
}
