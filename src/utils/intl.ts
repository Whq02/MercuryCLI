/**
 * Process-lifetime cache of internationalisation objects — each costs
 * roughly a tenth of a millisecond to construct.
 */

let graphemeSegmenter: Intl.Segmenter | null = null
let wordSegmenter: Intl.Segmenter | null = null
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>()
let timeZone: string | null = null
/** Three states: not computed (undefined), available (string), unavailable (null). */
let systemLocaleLanguage: string | null | undefined

export function getGraphemeSegmenter(): Intl.Segmenter {
  if (!graphemeSegmenter) graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return graphemeSegmenter
}

export function getWordSegmenter(): Intl.Segmenter {
  if (!wordSegmenter) wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
  return wordSegmenter
}

/**
 * The ONE word-boundary grammar for every text field (sweep #2,
 * packet 22): the composer's Cursor, the dialog fields that ride it, and
 * the search boxes all step and kill by these two functions — locale word
 * segmentation, never an ASCII character class that splits "café" or a CJK
 * phrase differently from the prompt beside it (law 6).
 */
export function wordStartBefore(text: string, at: number): number {
  if (at <= 0) return 0
  let candidate = 0
  for (const seg of getWordSegmenter().segment(text)) {
    if (!seg.isWordLike) continue
    const start = seg.index
    const end = seg.index + seg.segment.length
    if (at > start && at <= end) return start
    if (start < at) candidate = start
    else break
  }
  return candidate
}

/** The start of the next word-like segment strictly after `at` (the
 *  composer's forward step and forward kill both land there — trailing
 *  separators go with the word), else the end of the text. */
export function wordStartAfter(text: string, at: number): number {
  if (at >= text.length) return text.length
  for (const seg of getWordSegmenter().segment(text)) {
    if (!seg.isWordLike) continue
    if (seg.index > at) return seg.index
  }
  return text.length
}

/**
 * CONTENT slicing on grapheme boundaries (sweep #2, packet 77 —
 * distinct from display-width truncation): a payload capped by code-unit
 * count must never end mid-surrogate or mid-cluster, or the model reads
 * mojibake where the operator's text was whole. `sliceHead` keeps at most
 * `maxUnits` code units from the start, `sliceTail` from the end; both snap
 * inward to the nearest grapheme boundary. Cheap: only the boundary region
 * is segmented.
 */
export function sliceHeadAtGrapheme(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return ''
  if (text.length <= maxUnits) return text
  // Look at a bounded window around the cut: a grapheme cluster is short.
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

/** Indexing by code unit splits emoji and combining sequences; these do not. */
export function firstGrapheme(text: string): string {
  if (text === '') return ''
  for (const segment of getGraphemeSegmenter().segment(text)) return segment.segment
  return ''
}

export function lastGrapheme(text: string): string {
  if (text === '') return ''
  let last = ''
  for (const segment of getGraphemeSegmenter().segment(text)) last = segment.segment
  return last
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
  if (timeZone === null) timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return timeZone
}

/** The system locale's language subtag; an environment with a stripped ICU fails once, not per call. */
export function getSystemLocaleLanguage(): string | undefined {
  if (systemLocaleLanguage === undefined) {
    try {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale
      systemLocaleLanguage = new Intl.Locale(locale).language || null
    } catch {
      systemLocaleLanguage = null
    }
  }
  return systemLocaleLanguage ?? undefined
}
