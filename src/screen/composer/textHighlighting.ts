import { reduceAnsiCodes, tokenize, undoAnsiCodes, type AnsiCode } from '@alcalzone/ansi-tokenize'
import { ansiCodesToString } from '@alcalzone/ansi-tokenize'

import type { Theme } from '../theme/theme.js'
import type { HexColor } from '../renderer/styles.js'


export type TextHighlight = {
  start: number
  end: number
  color?: keyof Theme | HexColor | null
  shimmerColor?: keyof Theme | HexColor
  dimColor?: boolean
  inverse?: boolean
  priority: number
}

type TextSegment = {
  text: string
  start: number
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
  highlight: TextHighlight
}

function buildRanges(plainLength: number, highlights: TextHighlight[]): HighlightRange[] {
  const candidates: ClampedHighlight[] = []
  for (const highlight of highlights) {
    if (highlight.end <= highlight.start) continue
    const start = Math.max(0, Math.min(plainLength, highlight.start))
    const end = Math.max(0, Math.min(plainLength, highlight.end))
    if (start < end) {
      candidates.push({ start, end, highlight })
    }
  }
  if (candidates.length === 0) return []

  candidates.sort((a, b) => a.highlight.start - b.highlight.start || b.highlight.priority - a.highlight.priority)

  const accepted: ClampedHighlight[] = []
  let lastEnd = 0
  for (const item of candidates) {
    if (item.start >= lastEnd) {
      accepted.push(item)
      lastEnd = item.end
    }
  }
  if (accepted.length === 0) return []

  const ranges: HighlightRange[] = []
  let cursor = 0
  for (const item of accepted) {
    if (item.start > cursor) {
      ranges.push({ start: cursor, end: item.start })
    }
    ranges.push({ start: item.start, end: item.end, highlight: item.highlight })
    cursor = item.end
  }
  if (cursor < plainLength) {
    ranges.push({ start: cursor, end: plainLength })
  }
  return ranges
}

function openStyles(codes: AnsiCode[]): AnsiCode[] {
  return reduceAnsiCodes(codes).filter(code => code.code !== code.endCode)
}

export function segmentTextByHighlights(text: string, highlights: TextHighlight[]): TextSegment[] {
  if (highlights.length === 0) {
    return [{ text, start: 0 }]
  }

  if (!text.includes('\x1b') && !text.includes('\x9b')) {
    const ranges = buildRanges(text.length, highlights)
    if (ranges.length === 0) return [{ text, start: 0 }]
    return ranges.map(range =>
      range.highlight
        ? { text: text.slice(range.start, range.end), start: range.start, highlight: range.highlight }
        : { text: text.slice(range.start, range.end), start: range.start },
    )
  }

  const tokens = tokenize(text)
  let plainLength = 0
  for (const token of tokens) {
    if (token.type === 'char') plainLength += token.value.length
  }

  const ranges = buildRanges(plainLength, highlights)
  if (ranges.length === 0) return [{ text, start: 0 }]

  const segments: TextSegment[] = []
  let activeCodes: AnsiCode[] = []
  let segmentActiveCodes: AnsiCode[] = []
  let segmentStarted = false
  let segmentStart = 0
  let buf = ''
  let plainPos = 0
  let rangeIndex = 0

  for (const token of tokens) {
    if (token.type === 'ansi') {
      activeCodes = openStyles([...activeCodes, token])
      if (segmentStarted) {
        buf += token.code
        segmentActiveCodes = openStyles([...segmentActiveCodes, token])
      }
      continue
    }
    if (token.type === 'control') {
      if (rangeIndex >= ranges.length && segments.length > 0) {
        segments[segments.length - 1]!.text += token.code
      } else {
        buf += token.code
      }
      continue
    }
    let remaining = token.value
    while (remaining.length > 0 && rangeIndex < ranges.length) {
      const current = ranges[rangeIndex]!
      if (!segmentStarted) {
        segmentStarted = true
        segmentStart = plainPos
        if (activeCodes.length > 0) {
          buf += ansiCodesToString(activeCodes)
          segmentActiveCodes = [...activeCodes]
        }
      }
      const need = current.end - plainPos
      const take = Math.min(remaining.length, need)
      buf += remaining.slice(0, take)
      remaining = remaining.slice(take)
      plainPos += take

      if (plainPos >= current.end) {
        if (segmentActiveCodes.length > 0) {
          buf += ansiCodesToString(undoAnsiCodes(segmentActiveCodes))
        }
        segments.push(
          current.highlight
            ? { text: buf, start: segmentStart, highlight: current.highlight }
            : { text: buf, start: segmentStart },
        )
        buf = ''
        segmentStarted = false
        segmentActiveCodes = []
        rangeIndex++
        while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= plainPos) {
          rangeIndex++
        }
      }
    }
  }

  if (segmentStarted && buf !== '' && rangeIndex < ranges.length) {
    if (segmentActiveCodes.length > 0) {
      buf += ansiCodesToString(undoAnsiCodes(segmentActiveCodes))
    }
    const current = ranges[rangeIndex]!
    segments.push(
      current.highlight
        ? { text: buf, start: segmentStart, highlight: current.highlight }
        : { text: buf, start: segmentStart },
    )
  }

  return segments.length > 0 ? segments : [{ text, start: 0 }]
}
