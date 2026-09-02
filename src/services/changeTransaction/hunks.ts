
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { changeTransactionEnabled } from './contracts.js'
import {
  anchorDomainLines,
  formatStaleLineAnchorRefusal,
  lineAnchorsEnabled,
  parseHashedLinesSpelling,
  verifyLineRef,
  type LineRef,
} from './lineAnchors.js'
import { parseAnchor } from './snapshotAnchor.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function editHunksEnabled(): boolean {
  return (
    changeTransactionEnabled() &&
    !isEnvDefinedFalsy(flagEnv('MERCURY_EDIT_HUNKS'))
  )
}

export interface EditHunkInput {
  lines: string
  replace: string
  insert?: 'before' | 'after'
}

export interface HunkSpan {
  index: number
  start: number
  end: number
  insert?: 'before' | 'after'
  replace: string
}

export type HunkPlan =
  | { ok: true; spans: HunkSpan[]; totalLines: number }
  | { ok: false; message: string }

function parseHunkRange(lines: string): { start: number; end: number } | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(lines.trim())
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] !== undefined ? Number(m[2]) : start
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  return { start, end }
}

export function countLines(content: string): number {
  if (content === '') return 0
  const lines = content.split('\n')
  return content.endsWith('\n') ? lines.length - 1 : lines.length
}

export function planHunks(
  content: string,
  hunks: EditHunkInput[],
  expectedAnchor?: string,
): HunkPlan {
  if (hunks.length === 0) {
    return { ok: false, message: 'hunks is empty — provide at least one hunk or use old_string/new_string' }
  }
  const anchorsOn = lineAnchorsEnabled()
  let domainLines: string[] | null = null
  const totalLines = countLines(content)
  const parsedAnchor = expectedAnchor ? parseAnchor(expectedAnchor) : null
  const window =
    parsedAnchor?.kind === 'range'
      ? { start: parsedAnchor.startLine, end: parsedAnchor.startLine + parsedAnchor.lineCount - 1 }
      : null
  const spans: HunkSpan[] = []
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i]!
    let range: { start: number; end: number } | null = null
    let refs: LineRef[] | null = null
    const hashed = anchorsOn ? parseHashedLinesSpelling(h.lines) : null
    if (hashed !== null) {
      if (!hashed.ok) {
        return { ok: false, message: `hunk ${i + 1}: ${hashed.message}` }
      }
      range = { start: hashed.start.line, end: hashed.end.line }
      refs = hashed.start.line === hashed.end.line ? [hashed.start] : [hashed.start, hashed.end]
    } else {
      range = parseHunkRange(h.lines)
    }
    if (!range) {
      return { ok: false, message: `hunk ${i + 1}: lines '${h.lines}' does not parse — use "N" or "N-M" (1-based, inclusive)` }
    }
    if (range.start < 1) {
      return { ok: false, message: `hunk ${i + 1}: lines are 1-based — '${h.lines}' starts below 1` }
    }
    if (range.end < range.start) {
      return { ok: false, message: `hunk ${i + 1}: range '${h.lines}' ends before it starts` }
    }
    if (h.insert && range.end !== range.start) {
      return { ok: false, message: `hunk ${i + 1}: insert takes a single anchor line, not a range ('${h.lines}')` }
    }
    if (h.insert && h.replace === '') {
      return { ok: false, message: `hunk ${i + 1}: insert with an empty body does nothing — drop the hunk` }
    }
    if (refs) {
      if (domainLines === null) domainLines = anchorDomainLines(content)
      for (const ref of refs) {
        const verdict = verifyLineRef(domainLines, ref)
        if (!verdict.ok) {
          return {
            ok: false,
            message: formatStaleLineAnchorRefusal({
              hunkIndex: i + 1,
              spelling: h.lines,
              failure: verdict,
              domainLines,
            }),
          }
        }
      }
    }
    if (range.end > totalLines) {
      return { ok: false, message: `hunk ${i + 1}: lines '${h.lines}' out of bounds — the file has ${totalLines} line(s)` }
    }
    if (window && (range.start < window.start || range.end > window.end)) {
      return { ok: false, message: `hunk ${i + 1}: lines '${h.lines}' fall outside the read window L${window.start}-L${window.end} the range anchor covers — re-read the wider range first` }
    }
    spans.push({ index: i + 1, start: range.start, end: range.end, insert: h.insert, replace: h.replace })
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    if (cur.start <= prev.end) {
      return { ok: false, message: `hunk ${prev.index} and hunk ${cur.index} overlap (lines ${prev.start}-${prev.end} vs ${cur.start}-${cur.end}) — hunks must be disjoint` }
    }
  }
  return { ok: true, spans: sorted, totalLines }
}

function replacementLines(replace: string): string[] {
  if (replace === '') return []
  const body = replace.endsWith('\n') ? replace.slice(0, -1) : replace
  return body.split('\n')
}

export function applyHunks(content: string, plan: Extract<HunkPlan, { ok: true }>): string {
  const hadTrailingNL = content.endsWith('\n')
  const lines = content === '' ? [] : content.split('\n')
  if (hadTrailingNL) lines.pop()
  for (let i = plan.spans.length - 1; i >= 0; i--) {
    const span = plan.spans[i]!
    const rep = replacementLines(span.replace)
    if (span.insert === 'before') {
      lines.splice(span.start - 1, 0, ...rep)
    } else if (span.insert === 'after') {
      lines.splice(span.end, 0, ...rep)
    } else {
      lines.splice(span.start - 1, span.end - span.start + 1, ...rep)
    }
  }
  if (lines.length === 0) return ''
  return lines.join('\n') + (hadTrailingNL ? '\n' : '')
}

export function spanText(content: string, span: HunkSpan): string {
  const lines = content.split('\n')
  return lines.slice(span.start - 1, span.end).join('\n')
}

export function planApplyRegions(
  plan: Extract<HunkPlan, { ok: true }>,
): Array<{ start: number; lineCount: number }> {
  let delta = 0
  const regions: Array<{ start: number; lineCount: number }> = []
  for (const span of plan.spans) {
    const rep = replacementLines(span.replace)
    if (span.insert === 'before') {
      regions.push({ start: span.start + delta, lineCount: rep.length })
      delta += rep.length
    } else if (span.insert === 'after') {
      regions.push({ start: span.end + delta + 1, lineCount: rep.length })
      delta += rep.length
    } else {
      const oldLen = span.end - span.start + 1
      regions.push({ start: span.start + delta, lineCount: rep.length })
      delta += rep.length - oldLen
    }
  }
  return regions
}

export function hunksToEdits(
  content: string,
  plan: Extract<HunkPlan, { ok: true }>,
): Array<{ old_string: string; new_string: string; replace_all: boolean }> {
  return plan.spans.map(span => {
    const original = spanText(content, span)
    if (span.insert === 'before') {
      return { old_string: original, new_string: `${span.replace}\n${original}`, replace_all: false }
    }
    if (span.insert === 'after') {
      return { old_string: original, new_string: `${original}\n${span.replace}`, replace_all: false }
    }
    return { old_string: original, new_string: span.replace, replace_all: false }
  })
}
