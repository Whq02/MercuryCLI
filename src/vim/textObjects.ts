// ============================================================================
//  Text-object boundary finding: word/WORD runs, quote pairs (by ordinal
//  position, within the current logical line), and bracket pairs. Pure over
//  the raw text; iteration is grapheme-safe.
// ============================================================================

import { getGraphemeSegmenter } from '../utils/intl.js'
import { isVimWhitespace, isVimWordChar } from '../utils/Cursor.js'

export type TextObjectRange = { start: number; end: number } | null

const QUOTES = new Set(['"', "'", '`'])

const BRACKETS: Record<string, { open: string; close: string }> = {
  '(': { open: '(', close: ')' },
  ')': { open: '(', close: ')' },
  b: { open: '(', close: ')' },
  '[': { open: '[', close: ']' },
  ']': { open: '[', close: ']' },
  '{': { open: '{', close: '}' },
  '}': { open: '{', close: '}' },
  B: { open: '{', close: '}' },
  '<': { open: '<', close: '>' },
  '>': { open: '<', close: '>' },
}

type Grapheme = { index: number; segment: string }

function graphemesOf(text: string): Grapheme[] {
  const out: Grapheme[] = []
  for (const seg of getGraphemeSegmenter().segment(text)) {
    out.push({ index: seg.index, segment: seg.segment })
  }
  return out
}

export function findTextObject(
  text: string,
  offset: number,
  objectType: string,
  isInner: boolean,
): TextObjectRange {
  if (objectType === 'w' || objectType === 'W') {
    return findRunObject(text, offset, objectType, isInner)
  }
  if (QUOTES.has(objectType)) {
    return findQuoteObject(text, offset, objectType, isInner)
  }
  const bracket = BRACKETS[objectType]
  if (bracket) {
    return findBracketObject(text, offset, bracket.open, bracket.close, isInner)
  }
  return null
}

// ── word / WORD runs ────────────────────────────────────────────────────────

type RunClass = 'word' | 'space' | 'punct'

function classify(ch: string, wordType: 'w' | 'W'): RunClass {
  if (isVimWhitespace(ch)) return 'space'
  if (wordType === 'W') return 'word' // any non-whitespace
  return isVimWordChar(ch) ? 'word' : 'punct'
}

function findRunObject(
  text: string,
  offset: number,
  wordType: 'w' | 'W',
  isInner: boolean,
): TextObjectRange {
  const graphemes = graphemesOf(text)
  // An empty document has no grapheme to anchor on: no object (ruled — the
  // original faulted here).
  if (graphemes.length === 0) return null

  // The grapheme containing the offset; past the end falls back to the last.
  let gi = graphemes.length - 1
  for (let i = 0; i < graphemes.length; i++) {
    const g = graphemes[i]!
    if (offset >= g.index && offset < g.index + g.segment.length) {
      gi = i
      break
    }
  }

  const cls = classify(graphemes[gi]!.segment, wordType)
  let startIdx = gi
  while (startIdx > 0 && classify(graphemes[startIdx - 1]!.segment, wordType) === cls) {
    startIdx--
  }
  let endIdx = gi
  while (
    endIdx < graphemes.length - 1 &&
    classify(graphemes[endIdx + 1]!.segment, wordType) === cls
  ) {
    endIdx++
  }
  const runStart = graphemes[startIdx]!.index
  const runEnd = graphemes[endIdx]!.index + graphemes[endIdx]!.segment.length

  // On whitespace the object is the whitespace run, returned IMMEDIATELY —
  // "around" does not extend it.
  if (cls === 'space' || isInner) return { start: runStart, end: runEnd }

  // Around: extend over the trailing whitespace run when there is one,
  // otherwise over the leading whitespace run.
  let trailingEnd = endIdx
  while (
    trailingEnd < graphemes.length - 1 &&
    classify(graphemes[trailingEnd + 1]!.segment, wordType) === 'space'
  ) {
    trailingEnd++
  }
  if (trailingEnd > endIdx) {
    return {
      start: runStart,
      end: graphemes[trailingEnd]!.index + graphemes[trailingEnd]!.segment.length,
    }
  }
  let leadingStart = startIdx
  while (leadingStart > 0 && classify(graphemes[leadingStart - 1]!.segment, wordType) === 'space') {
    leadingStart--
  }
  return { start: graphemes[leadingStart]!.index, end: runEnd }
}

// ── quote pairs (current logical line; paired by ordinal position) ──────────

function findQuoteObject(
  text: string,
  offset: number,
  quote: string,
  isInner: boolean,
): TextObjectRange {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  const newlineIdx = text.indexOf('\n', offset)
  const lineEnd = newlineIdx === -1 ? text.length : newlineIdx

  const positions: number[] = []
  for (let i = lineStart; i < lineEnd; i++) {
    if (text[i] === quote) positions.push(i)
  }
  // 1st pairs with 2nd, 3rd with 4th, …; the object is the first pair whose
  // span contains the offset inclusively.
  for (let p = 0; p + 1 < positions.length; p += 2) {
    const open = positions[p]!
    const close = positions[p + 1]!
    if (offset >= open && offset <= close) {
      return isInner ? { start: open + 1, end: close } : { start: open, end: close + 1 }
    }
  }
  return null
}

// ── bracket pairs ───────────────────────────────────────────────────────────

function findBracketObject(
  text: string,
  offset: number,
  open: string,
  close: string,
  isInner: boolean,
): TextObjectRange {
  // Backwards for the nearest unmatched opener; a closing delimiter at a
  // position other than the caret increases depth.
  let openIdx = -1
  let depth = 0
  for (let i = Math.min(offset, text.length - 1); i >= 0; i--) {
    const ch = text[i]
    if (ch === close && i !== offset) {
      depth++
    } else if (ch === open) {
      if (depth === 0) {
        openIdx = i
        break
      }
      depth--
    }
  }
  if (openIdx === -1) return null

  let closeIdx = -1
  let forwardDepth = 0
  for (let j = openIdx + 1; j < text.length; j++) {
    const ch = text[j]
    if (ch === open) {
      forwardDepth++
    } else if (ch === close) {
      if (forwardDepth === 0) {
        closeIdx = j
        break
      }
      forwardDepth--
    }
  }
  if (closeIdx === -1) return null

  return isInner
    ? { start: openIdx + 1, end: closeIdx }
    : { start: openIdx, end: closeIdx + 1 }
}
