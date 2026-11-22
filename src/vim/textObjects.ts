import { getGraphemeSegmenter } from '../utils/intl.js'
import { isVimWhitespace, isVimWordChar } from '../utils/Cursor.js'
import { notBuilt } from '../pi/holes.js'

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

export function findTextObject(
  text: string,
  offset: number,
  objectType: string,
  isInner: boolean,
): TextObjectRange {
  return notBuilt('src/vim/textObjects.ts:32')
}


type RunClass = 'word' | 'space' | 'punct'

function classify(ch: string, wordType: 'w' | 'W'): RunClass {
  if (isVimWhitespace(ch)) return 'space'
  if (wordType === 'W') return 'word'
  return isVimWordChar(ch) ? 'word' : 'punct'
}
