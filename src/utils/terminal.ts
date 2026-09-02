// ============================================================================
//  Fold-and-truncate rendering for tool output blocks: three visible lines
//  plus a remaining-lines tail, with a large-content guard so a huge binary
//  dump never wraps into hundreds of thousands of rows — and a cheap
//  "would this be truncated" predicate.
// ============================================================================

import sliceAnsi from './sliceAnsi.js'
import { ctrlOToExpand } from '../components/CtrlOToExpand.js'

/** Lines shown before folding. */
const VISIBLE_LINES = 3

/** Fixed width allowance for the result-line prefix and the parent's own
 *  width reduction. */
const WIDTH_ALLOWANCE = 12

/** Floor for the wrap width. */
const MIN_WRAP_WIDTH = 10

export function renderTruncatedContent(
  content: string,
  terminalWidth: number,
  suppressExpandHint: boolean = false,
): string {
  const trimmedContent = content.replace(/\s+$/, '')
  if (trimmedContent === '') return ''

  const wrapWidth = Math.max(MIN_WRAP_WIDTH, terminalWidth - WIDTH_ALLOWANCE)

  // Large-content guard: only enough leading content to fill the visible
  // lines is processed (ANSI-aware slice), so wrapping cost is bounded.
  const maxChars = VISIBLE_LINES * wrapWidth * 4
  const preTruncated = trimmedContent.length > maxChars
  const working = preTruncated ? sliceAnsi(trimmedContent, 0, maxChars) : trimmedContent

  // Split on newlines, then chunk each long line at the wrap width with
  // ANSI-aware slicing so escape sequences are never split.
  const lines: string[] = []
  for (const raw of working.split('\n')) {
    if (raw.length === 0) {
      lines.push('')
      continue
    }
    let rest = raw
    while (rest.length > 0) {
      const chunk = sliceAnsi(rest, 0, wrapWidth)
      lines.push(chunk.replace(/\s+$/, ''))
      const after = sliceAnsi(rest, wrapWidth)
      if (after === rest) break
      rest = after
    }
  }

  const remainingLines = lines.length - VISIBLE_LINES

  // Exactly one hidden line costs the same space as its own hint: show
  // four lines and report nothing remaining.
  if (!preTruncated && remainingLines === 1) {
    return lines.slice(0, VISIBLE_LINES + 1).join('\n')
  }
  if (!preTruncated && remainingLines <= 0) {
    return lines.join('\n')
  }

  // Pre-truncated content estimates the remainder from the total length:
  // the larger of the observed remainder and ceil(length / wrapWidth) − 3,
  // marked approximate with a tilde (the estimate divides raw UTF-16
  // length, escape bytes included — honesty over precision, and O(1)).
  const estimate = preTruncated
    ? Math.max(remainingLines, Math.ceil(trimmedContent.length / wrapWidth) - VISIBLE_LINES)
    : remainingLines
  const shown = lines.slice(0, VISIBLE_LINES)
  const hint = suppressExpandHint ? '' : ` ${ctrlOToExpand()}`
  const tail = `… +${preTruncated ? '~' : ''}${estimate} lines${hint}`
  return [...shown, tail].join('\n')
}

/** Cheap check for "would the fold renderer truncate this": true iff the
 *  content has more than three newlines AND continues past the fourth. A
 *  trailing newline is a terminator, not a new line. Width wrapping is
 *  deliberately ignored (an accepted approximation, documented at call
 *  sites). */
export function isOutputLineTruncated(content: string): boolean {
  let idx = -1
  for (let i = 0; i < 4; i++) {
    idx = content.indexOf('\n', idx + 1)
    if (idx === -1) return false
  }
  return idx < content.length - 1
}
