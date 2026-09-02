
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import type { EditHunkInput } from './hunks.js'
import { parseAnchor } from './snapshotAnchor.js'

export function staleEditRecoveryEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_EDIT_STALE_RECOVERY'))
}

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
      if (hits.length > 2) return hits
    }
  }
  return hits
}

export function recoverStaleHunks(opts: {
  staleAnchor: string
  snapshotContent: string
  currentContent: string
  hunks: EditHunkInput[]
  displayPath: string
}): StaleRecoveryOutcome {
  const parsed = parseAnchor(opts.staleAnchor)
  if (!parsed) return { ok: false, reason: 'the stale anchor does not parse' }
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
    const newStart = hits[0]! + ctxAbove + 1
    const newEnd = newStart + (relEnd - relStart)
    const newSpelling = newStart === newEnd ? `${newStart}` : `${newStart}-${newEnd}`
    relocated.push({
      hunk: { ...h, lines: newSpelling },
      note: `lines ${h.lines} → ${newSpelling}`,
      newStart,
      newEnd,
    })
  }

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
