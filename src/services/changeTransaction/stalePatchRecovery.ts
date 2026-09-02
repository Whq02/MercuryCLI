// ============================================================================
//  changeTransaction/stalePatchRecovery — bounded unique-relocation recovery
//  for stale anchors on the patch path.
//
//  When a patch carries a stale anchor, the file changed after the model's
//  read. Recovery applies ONLY when it is provably safe:
//    1. the session's snapshot ring still holds the EXACT text the stale
//       anchor was minted from (verified by re-minting);
//    2. every hunk's span text — WITH surrounding context from that
//       snapshot — occurs at EXACTLY ONE position in the current content
//       (byte-identical, so the content inside the hunk window is unchanged
//       and merely MOVED);
//    3. the relocated spans are pairwise disjoint and in the original order.
//  Anything less falls back to the existing typed staleness refusal with
//  the current anchor. Recovery therefore never rewrites content that
//  changed inside a window — it only follows code that moved.
//
//  Full three-way merge is a NAMED non-goal (correctness risk); this is the
//  provably-safe subset. Proof: scripts/edit-tools/prove-stale-recovery.ts.
// ============================================================================

import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import type { EditHunkInput } from './hunks.js'
import { parseAnchor } from './snapshotAnchor.js'

/**
 * The DEFAULT edit path's relocation gate (FN-013 LOOP-03, registered as
 * MERCURY_EDIT_STALE_RECOVERY): default-ON — the surface almost every edit
 * uses attempts the same provably-safe relocation the opt-in anchor-patch
 * lane always ran, before refusing. `=0` restores the pre-law build
 * exactly: no ring writes for the default lane, every stale anchor refuses
 * with today's message. Read live per call (authority-toggle honesty).
 */
export function staleEditRecoveryEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_EDIT_STALE_RECOVERY'))
}

/** Context lines carried on each side of a span when searching. */
const RELOCATION_CONTEXT_LINES = 2

export interface RelocatedHunk {
  hunk: EditHunkInput
  oldSpelling: string
  newSpelling: string
}

export type StaleRecoveryOutcome =
  | { ok: true; hunks: EditHunkInput[]; warnings: string[] }
  | { ok: false; reason: string }

function parseLineSpelling(lines: string): { start: number; end: number } | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(lines.trim())
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] !== undefined ? Number(m[2]) : start
  return { start, end }
}

/** Find every index at which `needle` occurs as a contiguous line block. */
function findBlockOccurrences(haystack: string[], needle: string[]): number[] {
  if (needle.length === 0 || needle.length > haystack.length) return []
  const hits: number[] = []
  const first = needle[0]!
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (haystack[i] !== first) continue
    let match = true
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false
        break
      }
    }
    if (match) {
      hits.push(i)
      if (hits.length > 2) return hits // more than one is already a refusal
    }
  }
  return hits
}

/**
 * Attempt the provably-unique relocation of a hunk set from the anchored
 * snapshot onto the current content. Pure; no fs.
 *
 * `snapshotContent` is the text the STALE anchor was minted from (whole file
 * for fa:, the read window for ra: — line numbers in the hunks are absolute
 * file lines either way, exactly as the dialect defines them).
 */
export function recoverStaleHunks(opts: {
  staleAnchor: string
  snapshotContent: string
  currentContent: string
  hunks: EditHunkInput[]
  displayPath: string
}): StaleRecoveryOutcome {
  const parsed = parseAnchor(opts.staleAnchor)
  if (!parsed) return { ok: false, reason: 'the stale anchor does not parse' }
  // Absolute line of snapshotContent's first line.
  const snapshotBase = parsed.kind === 'range' ? parsed.startLine : 1
  const snapLines = opts.snapshotContent.split('\n')
  if (opts.snapshotContent.endsWith('\n')) snapLines.pop()
  const curLines = opts.currentContent.split('\n')
  if (opts.currentContent.endsWith('\n')) curLines.pop()

  const relocated: Array<{ hunk: EditHunkInput; note: string; newStart: number; newEnd: number }> = []
  for (let i = 0; i < opts.hunks.length; i++) {
    const h = opts.hunks[i]!
    const span = parseLineSpelling(h.lines)
    if (!span) return { ok: false, reason: `hunk ${i + 1}: '${h.lines}' does not parse` }
    // Snapshot-relative indices (0-based).
    const relStart = span.start - snapshotBase
    const relEnd = span.end - snapshotBase
    if (relStart < 0 || relEnd >= snapLines.length) {
      return { ok: false, reason: `hunk ${i + 1}: lines ${h.lines} fall outside the recorded snapshot` }
    }
    const ctxAbove = Math.min(RELOCATION_CONTEXT_LINES, relStart)
    const ctxBelow = Math.min(RELOCATION_CONTEXT_LINES, snapLines.length - 1 - relEnd)
    const needle = snapLines.slice(relStart - ctxAbove, relEnd + ctxBelow + 1)
    const hits = findBlockOccurrences(curLines, needle)
    if (hits.length === 0) {
      return {
        ok: false,
        reason: `hunk ${i + 1} (lines ${h.lines}): the anchored text no longer appears in ${opts.displayPath} — the content changed, not just moved`,
      }
    }
    if (hits.length > 1) {
      return {
        ok: false,
        reason: `hunk ${i + 1} (lines ${h.lines}): the anchored text appears ${hits.length > 2 ? 'more than twice' : 'twice'} in ${opts.displayPath} — relocation is ambiguous`,
      }
    }
    const newStart = hits[0]! + ctxAbove + 1 // 1-based current line
    const newEnd = newStart + (relEnd - relStart)
    const newSpelling = newStart === newEnd ? `${newStart}` : `${newStart}-${newEnd}`
    relocated.push({
      hunk: { ...h, lines: newSpelling },
      note: `lines ${h.lines} → ${newSpelling}`,
      newStart,
      newEnd,
    })
  }

  // Disjointness + order preservation over the relocated spans.
  const sorted = [...relocated].sort((a, b) => a.newStart - b.newStart)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.newStart <= sorted[i - 1]!.newEnd) {
      return { ok: false, reason: 'relocated hunks would overlap — relocation is ambiguous' }
    }
  }
  for (let i = 1; i < relocated.length; i++) {
    if (relocated[i]!.newStart < relocated[i - 1]!.newStart) {
      return { ok: false, reason: 'relocation would reorder the hunks — refused' }
    }
  }

  return {
    ok: true,
    hunks: relocated.map(r => r.hunk),
    warnings: relocated.map(r => `stale anchor recovered: ${r.note} (${opts.displayPath})`),
  }
}
