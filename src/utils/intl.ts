import { notBuilt } from '../pi/holes.js'

export function getGraphemeSegmenter(): Intl.Segmenter {
  return notBuilt('src/utils/intl.ts:7')
}

export function getWordSegmenter(): Intl.Segmenter {
  return notBuilt('src/utils/intl.ts:12')
}

export function wordStartBefore(text: string, at: number): number {
  return notBuilt('src/utils/intl.ts:17')
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
  return notBuilt('src/utils/intl.ts:69')
}

export function lastGrapheme(text: string): string {
  return notBuilt('src/utils/intl.ts:75')
}

export function getRelativeTimeFormat(
  style: 'long' | 'short' | 'narrow',
  numeric: 'always' | 'auto',
): Intl.RelativeTimeFormat {
  return notBuilt('src/utils/intl.ts:82')
}

export function getTimeZone(): string {
  return notBuilt('src/utils/intl.ts:95')
}
