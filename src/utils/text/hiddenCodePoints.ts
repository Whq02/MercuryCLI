export type HiddenCodePointClass =
  | 'an invisible character'
  | 'a zero-width joiner outside an emoji sequence'
  | 'a zero-width non-joiner outside a word'
  | 'a direction override'
  | 'a direction mark'
  | 'a soft hyphen'
  | 'a tag character'
  | 'a variation selector carrying no glyph'
  | 'a byte-order mark inside the text'
  | 'an invisible annotation mark'

export type HiddenCodePoint = {
  line: number
  column: number
  codePoint: number
  class: HiddenCodePointClass
}

const NON_ASCII = /[^\x00-\x7F]/
const LETTER = /^\p{L}$/u
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u
const WHITESPACE = /^\s$/u
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u
const JOINING_SCRIPT =
  /^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Tibetan}\p{Script=Mongolian}]$/u
const HAN = /^\p{Script=Han}$/u
const EAST_ASIAN_OR_MONGOLIAN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Mongolian}]$/u

const WAVING_BLACK_FLAG = 0x1f3f4
const CANCEL_TAG = 0xe007f
const SUBDIVISION_TAG_LIMIT = 6

const isVariationSelector = (cp: number): boolean => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
const isTag = (cp: number): boolean => cp >= 0xe0000 && cp <= 0xe007f
const isSkinTone = (cp: number): boolean => cp >= 0x1f3fb && cp <= 0x1f3ff
const str = (cp: number): string => String.fromCodePoint(cp)

export function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

function joinsWord(points: readonly number[], i: number): boolean {
  const before = points[i - 1]
  const after = points[i + 1]
  if (before === undefined || after === undefined) return false
  if (!LETTER_OR_MARK.test(str(before)) || !LETTER.test(str(after))) return false
  return JOINING_SCRIPT.test(str(before)) || JOINING_SCRIPT.test(str(after))
}

function joinsEmoji(points: readonly number[], i: number): boolean {
  let j = i - 1
  while (j >= 0 && (points[j] === 0xfe0f || isSkinTone(points[j]!))) j--
  const before = points[j]
  const after = points[i + 1]
  if (before === undefined || after === undefined) return false
  return PICTOGRAPHIC.test(str(before)) && PICTOGRAPHIC.test(str(after))
}

function selectsGlyph(points: readonly number[], i: number): boolean {
  const cp = points[i]!
  const before = points[i - 1]
  if (before === undefined || isVariationSelector(before) || WHITESPACE.test(str(before))) return false
  if (cp === 0xfe0e || cp === 0xfe0f) return !LETTER.test(str(before))
  if (cp >= 0xe0100) return HAN.test(str(before))
  return EAST_ASIAN_OR_MONGOLIAN.test(str(before))
}

function tagsSubdivisionFlag(points: readonly number[], i: number): boolean {
  let start = i
  while (start > 0 && isTag(points[start - 1]!)) start--
  if (points[start - 1] !== WAVING_BLACK_FLAG) return false
  let end = start
  while (end < points.length && isTag(points[end]!) && points[end] !== CANCEL_TAG) end++
  if (points[end] !== CANCEL_TAG) return false
  if (end - start > SUBDIVISION_TAG_LIMIT) return false
  for (let k = start; k < end; k++) {
    const tag = points[k]! - 0xe0000
    const letterOrDigit = (tag >= 0x61 && tag <= 0x7a) || (tag >= 0x30 && tag <= 0x39)
    if (!letterOrDigit) return false
  }
  return true
}

function classify(points: readonly number[], i: number): HiddenCodePointClass | null {
  const cp = points[i]!
  if (cp < 0x80) return null
  if (cp === 0x00ad) return 'a soft hyphen'
  if (cp === 0xfeff) return i === 0 ? null : 'a byte-order mark inside the text'
  if (cp === 0x200b || cp === 0x2060 || (cp >= 0x2061 && cp <= 0x2064) || cp === 0x180e) return 'an invisible character'
  if (cp === 0x200c) return joinsWord(points, i) ? null : 'a zero-width non-joiner outside a word'
  if (cp === 0x200d) return joinsWord(points, i) || joinsEmoji(points, i) ? null : 'a zero-width joiner outside an emoji sequence'
  if (cp === 0x200e || cp === 0x200f || cp === 0x061c) return 'a direction mark'
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return 'a direction override'
  if (cp >= 0xfff9 && cp <= 0xfffb) return 'an invisible annotation mark'
  if (isVariationSelector(cp)) return selectsGlyph(points, i) ? null : 'a variation selector carrying no glyph'
  if (isTag(cp)) return tagsSubdivisionFlag(points, i) ? null : 'a tag character'
  return null
}

export function findHiddenCodePoints(text: string): HiddenCodePoint[] {
  if (!NON_ASCII.test(text)) return []
  const points = Array.from(text, ch => ch.codePointAt(0)!)
  const found: HiddenCodePoint[] = []
  let line = 1
  let column = 0
  for (let i = 0; i < points.length; i++) {
    const cp = points[i]!
    if (cp === 0x0a) {
      line++
      column = 0
      continue
    }
    column++
    const kind = classify(points, i)
    if (kind !== null) found.push({ line, column, codePoint: cp, class: kind })
  }
  return found
}

export function describeHiddenCodePoint(found: HiddenCodePoint): string {
  return `line ${found.line}, column ${found.column}: ${found.class} (${codePointLabel(found.codePoint)})`
}

export function summarizeHiddenCodePoints(found: readonly HiddenCodePoint[]): string {
  const counts = new Map<HiddenCodePointClass, number>()
  for (const f of found) counts.set(f.class, (counts.get(f.class) ?? 0) + 1)
  return [...counts.entries()].map(([kind, n]) => (n === 1 ? kind : `${kind} ×${n}`)).join(', ')
}
