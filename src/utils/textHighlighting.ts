import { reduceAnsiCodes, tokenize, undoAnsiCodes, type AnsiCode } from '@alcalzone/ansi-tokenize'

import type { Theme } from './theme.js'

/**
 * Splits ANSI-bearing text into segments at highlight boundaries. Every
 * emitted segment is independently renderable: escape state entering a
 * segment is re-emitted as reduced opening codes, and the segment closes
 * with the sequences that undo its active codes.
 */

export type TextHighlight = {
  /** Visible-coordinate offsets (escape sequences excluded). */
  start: number
  end: number
  color?: keyof Theme | null | undefined
  dimColor?: boolean
  inverse?: boolean
  shimmerColor?: keyof Theme
  priority: number
}

export type TextSegment = {
  text: string
  /** Start position in visible coordinates. */
  start: number
  highlight?: TextHighlight
}

/**
 * Sorted by start ascending (priority descending on ties), zero-length
 * highlights dropped, and a highlight accepted only when its range does
 * not overlap any already-accepted range — so higher priority wins on
 * collisions.
 */
function resolveHighlights(highlights: TextHighlight[]): TextHighlight[] {
  const sorted = [...highlights].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : b.priority - a.priority,
  )
  const accepted: TextHighlight[] = []
  for (const highlight of sorted) {
    if (highlight.start >= highlight.end) continue
    const collides = accepted.some(
      range =>
        (highlight.start >= range.start && highlight.start < range.end) ||
        (highlight.end > range.start && highlight.end <= range.end) ||
        (highlight.start <= range.start && highlight.end >= range.end),
    )
    if (!collides) accepted.push(highlight)
  }
  return accepted
}

export function segmentTextByHighlights(text: string, highlights: TextHighlight[]): TextSegment[] {
  if (highlights.length === 0) {
    return [{ text, start: 0 }]
  }
  const accepted = resolveHighlights(highlights)
  if (accepted.length === 0) {
    return [{ text, start: 0 }]
  }

  const tokens = tokenize(text)
  const segments: TextSegment[] = []
  let tokenIndex = 0
  let visiblePos = 0
  let rawPos = 0
  // Escape codes seen so far — the carried styling state across segments.
  let activeCodes: AnsiCode[] = []

  const cutSegment = (targetVisible: number, highlight: TextHighlight | undefined): void => {
    if (targetVisible <= visiblePos) return
    if (tokenIndex >= tokens.length) return

    // Escapes before the first visible character belong to the segment's
    // OPENING STATE, consumed before the raw start is recorded, so they
    // are carried as state rather than as text.
    while (tokenIndex < tokens.length && (tokens[tokenIndex] as { type: string }).type === 'ansi') {
      const token = tokens[tokenIndex] as unknown as AnsiCode & { type: 'ansi' }
      activeCodes.push(token)
      rawPos += token.code.length
      tokenIndex++
    }

    const entering = reduceAnsiCodes(activeCodes).filter(code => code.code !== code.endCode)
    const segmentVisibleStart = visiblePos
    const segmentRawStart = rawPos

    while (tokenIndex < tokens.length && visiblePos < targetVisible) {
      const token = tokens[tokenIndex] as unknown as
        | (AnsiCode & { type: 'ansi' })
        | { type: 'control'; code: string }
        | { type: 'char'; value: string }
      if (token.type === 'ansi') {
        activeCodes.push(token)
        rawPos += token.code.length
      } else if (token.type === 'control') {
        // A non-styling control sequence: raw bytes, no visible cell, no state.
        rawPos += token.code.length
      } else {
        visiblePos++
        rawPos += token.value.length
      }
      tokenIndex++
    }

    const rawSpan = text.slice(segmentRawStart, rawPos)
    // A span holding only trailing escapes (or nothing) is omitted.
    if (rawSpan === '') return

    const leaving = reduceAnsiCodes(activeCodes).filter(code => code.code !== code.endCode)
    activeCodes = [...leaving]
    const opening = entering.map(code => code.code).join('')
    const closing = undoAnsiCodes(leaving)
      .map(code => code.code)
      .join('')
    segments.push({
      text: opening + rawSpan + closing,
      start: segmentVisibleStart,
      ...(highlight ? { highlight } : {}),
    })
  }

  for (const highlight of accepted) {
    cutSegment(highlight.start, undefined)
    cutSegment(highlight.end, highlight)
  }
  cutSegment(Number.POSITIVE_INFINITY, undefined)

  return segments
}
