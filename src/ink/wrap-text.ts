// Wrap / trim-wrap / truncate (start, middle, end) of a styled string. The
// wrap-union members `end` and `middle` do NOT begin with `truncate` and are
// deliberately inert here — several call sites pass them and rely on the
// text surviving untouched.

import sliceAnsi from '../utils/sliceAnsi.js'
import { stringWidth } from './stringWidth.js'
import { wrapAnsi } from './wrapAnsi.js'

const ELLIPSIS = '…'

// A slice can include a boundary-spanning wide character and overshoot the
// requested width by one; an overshooting slice is retried once with the
// bound tightened by one.
function leadingSlice(text: string, width: number): string {
  if (width <= 0) return ''
  let out = sliceAnsi(text, 0, width)
  if (stringWidth(out) > width) out = sliceAnsi(text, 0, width - 1)
  return out
}

function trailingSlice(text: string, width: number): string {
  if (width <= 0) return ''
  const total = stringWidth(text)
  let out = sliceAnsi(text, total - width)
  if (stringWidth(out) > width) out = sliceAnsi(text, total - width + 1)
  return out
}

// A soft wrap breaks AT a word-separator space, and with `trim: false` both
// wrapper implementations leave that separator at the START of the
// continuation line — every wrapped paragraph gains a ragged one-column
// indent wherever a word ends exactly at the limit (the
// PAINT-wrap-leading-space class). Separator whitespace collapses at a soft break
// (browser soft-wrap semantics); leading spaces the OPERATOR wrote survive,
// because they sit at the start of their own hard-break paragraph line,
// which is never stripped.

/** Strip the leading plain spaces of a soft-break continuation line while
 *  keeping any escape sequences (SGR / OSC 8) interleaved with them. */
function stripSoftBreakIndent(line: string): string {
  let i = 0
  let kept = ''
  while (i < line.length) {
    const ch = line[i]!
    if (ch === ' ') {
      i++
      continue
    }
    if (ch === '\x1b') {
      const m = /^\x1b(?:\[[0-9;?]*[A-Za-z]|\]8;;[^\x07\x1b]*(?:\x07|\x1b\\))/.exec(
        line.slice(i),
      )
      if (m) {
        kept += m[0]
        i += m[0].length
        continue
      }
    }
    break
  }
  return kept + line.slice(i)
}

/** Tell soft breaks from the input's own newlines by walking visible widths:
 *  with `trim: false` nothing is lost, so a paragraph's lines concatenate to
 *  exactly the paragraph — a line landing mid-paragraph is a continuation. */
function stripSoftWrapLeadingSpaces(input: string, wrapped: string): string {
  if (!wrapped.includes('\n')) return wrapped
  const paragraphWidths = input.split('\n').map(p => stringWidth(p))
  const lines = wrapped.split('\n')
  const out: string[] = []
  let paragraph = 0
  let consumed = 0
  for (const line of lines) {
    out.push(consumed > 0 ? stripSoftBreakIndent(line) : line)
    consumed += stringWidth(line)
    if (paragraph < paragraphWidths.length && consumed >= paragraphWidths[paragraph]!) {
      consumed = 0
      paragraph++
    }
  }
  return out.join('\n')
}

/** The structured truncation (FN-016 R11): `lead` is a PREFIX of the text
 *  and `trail` a SUFFIX — the compositor re-applies per-segment styles
 *  through exactly these boundaries, because a truncate-start or
 *  truncate-middle output is NOT position-preserving and a linear
 *  character map painted everything right of the ellipsis in the wrong
 *  colour. null means the text stays untouched: it fits, or the mode is no
 *  truncate mode at all (the inert union members `end` and `middle` never
 *  cut — layout measures them untouched, and so must the compositor). The
 *  ONE owner of the truncate arithmetic — wrapText's truncate arm is its
 *  caller. */
export function truncateParts(
  text: string,
  maxWidth: number,
  wrapType: string,
): { lead: string; ellipsis: boolean; trail: string } | null {
  if (!wrapType.startsWith('truncate')) return null
  if (maxWidth < 1) return { lead: '', ellipsis: false, trail: '' }
  if (maxWidth === 1) return { lead: '', ellipsis: true, trail: '' }
  if (stringWidth(text) <= maxWidth) return null

  if (wrapType === 'truncate-start') {
    return { lead: '', ellipsis: true, trail: trailingSlice(text, maxWidth - 1) }
  }
  if (wrapType === 'truncate-middle') {
    const leadBudget = Math.floor((maxWidth - 1) / 2)
    const lead = leadingSlice(text, leadBudget)
    const trail = trailingSlice(text, maxWidth - 1 - stringWidth(lead))
    return { lead, ellipsis: true, trail }
  }
  return { lead: leadingSlice(text, maxWidth - 1), ellipsis: true, trail: '' }
}

export default function wrapText(
  text: string,
  maxWidth: number,
  wrapType: string,
): string {
  if (wrapType === 'wrap') {
    return stripSoftWrapLeadingSpaces(
      text,
      wrapAnsi(text, maxWidth, { hard: true, trim: false }),
    )
  }
  if (wrapType === 'wrap-trim') {
    return wrapAnsi(text, maxWidth, { hard: true, trim: true })
  }
  const parts = truncateParts(text, maxWidth, wrapType)
  if (parts === null) return text
  return parts.lead + (parts.ellipsis ? ELLIPSIS : '') + parts.trail
}
