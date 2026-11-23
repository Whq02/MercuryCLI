let graphemeSegmenter: Intl.Segmenter | undefined
let wordSegmenter: Intl.Segmenter | undefined
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>()
let timeZone: string | undefined

export function getGraphemeSegmenter(): Intl.Segmenter {
  return graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
}

export function getWordSegmenter(): Intl.Segmenter {
  return wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' })
}

export function wordStartBefore(text: string, at: number): number {
  if (at <= 0) return 0
  let start = 0
  for (const seg of getWordSegmenter().segment(text)) {
    if (seg.index >= at) break
    if (seg.isWordLike) start = seg.index
  }
  return start
}

export function wordStartAfter(text: string, at: number): number {
  if (at >= text.length) return text.length
  for (const seg of getWordSegmenter().segment(text)) {
    if (!seg.isWordLike) continue
    if (seg.index > at) return seg.index
  }
  return text.length
}

export function sliceHeadAtGrapheme(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return ''
  if (text.length <= maxUnits) return text
  const windowStart = Math.max(0, maxUnits - 64)
  let end = windowStart
  for (const seg of getGraphemeSegmenter().segment(text.slice(windowStart, maxUnits + 64))) {
    const segEnd = windowStart + seg.index + seg.segment.length
    if (segEnd > maxUnits) break
    end = segEnd
  }
  return text.slice(0, end)
}

export function sliceTailAtGrapheme(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return ''
  if (text.length <= maxUnits) return text
  const cut = text.length - maxUnits
  const windowStart = Math.max(0, cut - 64)
  let start = text.length
  for (const seg of getGraphemeSegmenter().segment(text.slice(windowStart, cut + 64))) {
    const segStart = windowStart + seg.index
    if (segStart >= cut) {
      start = segStart
      break
    }
  }
  return text.slice(start)
}

export function firstGrapheme(text: string): string {
  return getGraphemeSegmenter().segment(text).containing(0)?.segment ?? ''
}

export function lastGrapheme(text: string): string {
  return getGraphemeSegmenter().segment(text).containing(text.length - 1)?.segment ?? ''
}

export function getRelativeTimeFormat(
  style: 'long' | 'short' | 'narrow',
  numeric: 'always' | 'auto',
): Intl.RelativeTimeFormat {
  const key = `${style}:${numeric}`
  let format = relativeTimeFormats.get(key)
  if (!format) {
    format = new Intl.RelativeTimeFormat('en', { style, numeric })
    relativeTimeFormats.set(key, format)
  }
  return format
}

export function getTimeZone(): string {
  return timeZone ??= new Intl.DateTimeFormat().resolvedOptions().timeZone
}
