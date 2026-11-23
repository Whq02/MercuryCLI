import { getGraphemeSegmenter } from '../utils/intl.js'
import { isVimWhitespace, isVimWordChar } from '../utils/Cursor.js'

type TextObjectRange = { start: number; end: number } | null

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

function findWordObject(
  text: string,
  offset: number,
  wordType: 'w' | 'W',
  isInner: boolean,
): TextObjectRange {
  const gs = graphemesOf(text)
  if (gs.length === 0) return null

  const clamped = Math.max(0, Math.min(offset, text.length - 1))
  let idx = 0
  for (let i = 0; i < gs.length; i++) {
    if (gs[i]!.index <= clamped) idx = i
    else break
  }

  const cls = classify(gs[idx]!.segment, wordType)
  let startIdx = idx
  let endIdx = idx

  while (startIdx > 0 && classify(gs[startIdx - 1]!.segment, wordType) === cls) {
    startIdx--
  }
  while (endIdx + 1 < gs.length && classify(gs[endIdx + 1]!.segment, wordType) === cls) {
    endIdx++
  }

  if (!isInner && cls !== 'space') {
    if (endIdx + 1 < gs.length && isVimWhitespace(gs[endIdx + 1]!.segment)) {
      while (endIdx + 1 < gs.length && isVimWhitespace(gs[endIdx + 1]!.segment)) {
        endIdx++
      }
    } else if (startIdx > 0 && isVimWhitespace(gs[startIdx - 1]!.segment)) {
      while (startIdx > 0 && isVimWhitespace(gs[startIdx - 1]!.segment)) {
        startIdx--
      }
    }
  }

  const endGrapheme = gs[endIdx]!
  return {
    start: gs[startIdx]!.index,
    end: endGrapheme.index + endGrapheme.segment.length,
  }
}

function findQuoteObject(
  text: string,
  offset: number,
  quote: string,
  isInner: boolean,
): TextObjectRange {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const prevNl = clamped > 0 ? text.lastIndexOf('\n', clamped - 1) : -1
  const lineStart = prevNl === -1 ? 0 : prevNl + 1
  const nextNl = text.indexOf('\n', clamped)
  const lineEnd = nextNl === -1 ? text.length : nextNl

  const positions: number[] = []
  for (let i = lineStart; i < lineEnd; i++) {
    if (text[i] === quote) positions.push(i)
  }

  for (let i = 0; i + 1 < positions.length; i += 2) {
    const open = positions[i]!
    const close = positions[i + 1]!
    if (open <= offset && offset <= close) {
      return isInner
        ? { start: open + 1, end: close }
        : { start: open, end: close + 1 }
    }
  }

  return null
}

function findBracketObject(
  text: string,
  offset: number,
  open: string,
  close: string,
  isInner: boolean,
): TextObjectRange {
  const pos = Math.max(0, Math.min(offset, text.length - 1))
  let openIdx = -1
  let depth = 0

  for (let i = pos; i >= 0; i--) {
    const ch = text[i]
    if (ch === close && i < pos) {
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
  depth = 0
  for (let i = openIdx + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === open) {
      depth++
    } else if (ch === close) {
      if (depth === 0) {
        closeIdx = i
        break
      }
      depth--
    }
  }

  if (closeIdx === -1) return null

  return isInner
    ? { start: openIdx + 1, end: closeIdx }
    : { start: openIdx, end: closeIdx + 1 }
}

export function findTextObject(
  text: string,
  offset: number,
  objectType: string,
  isInner: boolean,
): TextObjectRange {
  if (text.length === 0) return null
  if (objectType === 'w' || objectType === 'W') {
    return findWordObject(text, offset, objectType, isInner)
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


type RunClass = 'word' | 'space' | 'punct'

function classify(ch: string, wordType: 'w' | 'W'): RunClass {
  if (isVimWhitespace(ch)) return 'space'
  if (wordType === 'W') return 'word'
  return isVimWordChar(ch) ? 'word' : 'punct'
}
