import { reduceAnsiCodes, tokenize, undoAnsiCodes, type AnsiCode } from '@alcalzone/ansi-tokenize'

import type { Theme } from './theme.js'


export type TextHighlight = {
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
  start: number
  highlight?: TextHighlight
}

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
  let activeCodes: AnsiCode[] = []

  const cutSegment = (targetVisible: number, highlight: TextHighlight | undefined): void => {
    if (targetVisible <= visiblePos) return
    if (tokenIndex >= tokens.length) return

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
        rawPos += token.code.length
      } else {
        visiblePos++
        rawPos += token.value.length
      }
      tokenIndex++
    }

    const rawSpan = text.slice(segmentRawStart, rawPos)
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
