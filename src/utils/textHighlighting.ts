import { reduceAnsiCodes, tokenize, undoAnsiCodes, type AnsiCode } from '@alcalzone/ansi-tokenize'

import type { Theme } from './theme.js'
import type { HexColor } from '../ink/styles.js'


export type TextHighlight = {
  start: number
  end: number
  color?: keyof Theme | HexColor
  shimmerColor?: keyof Theme | HexColor
  dimColor?: boolean
  inverse?: boolean
  priority?: number
}

type TextSegment = {
  text: string
  highlight?: TextHighlight
}

type HighlightRange = {
  start: number
  end: number
  highlight?: TextHighlight
}

type ClampedHighlight = {
  start: number
  end: number
  priority: number
  order: number
  highlight: TextHighlight
}

function buildRanges(plainLength: number, highlights: TextHighlight[]): HighlightRange[] {
  const clamped: ClampedHighlight[] = []
  for (let i = 0; i < highlights.length; i++) {
    const highlight = highlights[i]!
    const start = Math.max(0, Math.min(plainLength, highlight.start))
    const end = Math.max(0, Math.min(plainLength, highlight.end))
    if (start < end) {
      clamped.push({
        start,
        end,
        priority: highlight.priority ?? 0,
        order: i,
        highlight,
      })
    }
  }
  if (clamped.length === 0) return []

  const pointSet = new Set<number>([0, plainLength])
  for (const item of clamped) {
    pointSet.add(item.start)
    pointSet.add(item.end)
  }
  const points = [...pointSet].sort((a, b) => a - b)

  const ranges: HighlightRange[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!
    const end = points[i + 1]!
    if (start >= end) continue
    let winner: ClampedHighlight | undefined
    for (const item of clamped) {
      if (item.start <= start && item.end >= end) {
        if (
          winner === undefined ||
          item.priority > winner.priority ||
          (item.priority === winner.priority && item.order < winner.order)
        ) {
          winner = item
        }
      }
    }
    const prev = ranges[ranges.length - 1]
    if (prev !== undefined && prev.highlight === winner?.highlight) {
      prev.end = end
    } else {
      ranges.push(winner ? { start, end, highlight: winner.highlight } : { start, end })
    }
  }
  return ranges
}

export function segmentTextByHighlights(text: string, highlights: TextHighlight[]): TextSegment[] {
  if (highlights.length === 0) {
    return [{ text }]
  }

  if (!text.includes('\x1b') && !text.includes('\x9b')) {
    const ranges = buildRanges(text.length, highlights)
    if (ranges.length === 0) return [{ text }]
    return ranges.map(range =>
      range.highlight
        ? { text: text.slice(range.start, range.end), highlight: range.highlight }
        : { text: text.slice(range.start, range.end) },
    )
  }

  const tokens = tokenize(text)
  let plainLength = 0
  for (const token of tokens) {
    if (token.type === 'char') plainLength += token.value.length
  }

  const ranges = buildRanges(plainLength, highlights)
  if (ranges.length === 0) return [{ text }]

  const segments: TextSegment[] = []
  let activeCodes: AnsiCode[] = []
  let segmentActiveCodes: AnsiCode[] = []
  let segmentStarted = false
  let buf = ''
  let plainPos = 0
  let rangeIndex = 0

  for (const token of tokens) {
    if (token.type === 'ansi') {
      activeCodes = reduceAnsiCodes([...activeCodes, token])
      if (segmentStarted) {
        buf += token.code
        segmentActiveCodes = reduceAnsiCodes([...segmentActiveCodes, token])
      }
      continue
    }
    if (token.type === 'control') {
      buf += token.code
      continue
    }
    if (rangeIndex >= ranges.length) break
    if (!segmentStarted) {
      segmentStarted = true
      if (activeCodes.length > 0) {
        buf += activeCodes.map(code => code.code).join('')
        segmentActiveCodes = [...activeCodes]
      }
    }
    buf += token.value
    plainPos += token.value.length

    const current = ranges[rangeIndex]!
    if (plainPos >= current.end) {
      if (segmentActiveCodes.length > 0) {
        buf += undoAnsiCodes(segmentActiveCodes).map(code => code.code).join('')
      }
      segments.push(current.highlight ? { text: buf, highlight: current.highlight } : { text: buf })
      buf = ''
      segmentStarted = false
      segmentActiveCodes = []
      rangeIndex++
      while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= plainPos) {
        rangeIndex++
      }
    }
  }

  if (segmentStarted && buf !== '' && rangeIndex < ranges.length) {
    if (segmentActiveCodes.length > 0) {
      buf += undoAnsiCodes(segmentActiveCodes).map(code => code.code).join('')
    }
    const current = ranges[rangeIndex]!
    segments.push(current.highlight ? { text: buf, highlight: current.highlight } : { text: buf })
  }

  return segments.length > 0 ? segments : [{ text }]
}
