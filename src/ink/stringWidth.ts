import emojiRegexFactory from 'emoji-regex'
import { eastAsianWidth } from 'get-east-asian-width'
import stripAnsi from 'strip-ansi'
import { getGraphemeSegmenter } from '../utils/intl.js'
import { terminalTextCells } from './session/terminalTextCells.js'

type NativeStringWidth = (
  input: string,
  options?: { countAnsiEscapeCodes?: boolean; ambiguousIsNarrow?: boolean },
) => number

const nativeStringWidth: NativeStringWidth | undefined = (
  globalThis as { Bun?: { stringWidth?: NativeStringWidth } }
).Bun?.stringWidth

function within(codePoint: number, first: number, last: number): boolean {
  return codePoint >= first && codePoint <= last
}

export function isHebrewArabicCombiningMark(codePoint: number): boolean {
  return (
    within(codePoint, 0x0591, 0x05bd) ||
    codePoint === 0x05bf ||
    codePoint === 0x05c1 ||
    codePoint === 0x05c2 ||
    codePoint === 0x05c4 ||
    codePoint === 0x05c5 ||
    codePoint === 0x05c7 ||
    within(codePoint, 0x064b, 0x065f) ||
    codePoint === 0x0670
  )
}

const HEBREW_ARABIC_MARK_RE =
  /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u064B-\u065F\u0670]/

const DIRECTIONAL_FORMAT_RE = /[\u061C\u180E\u200C-\u200F\u202A-\u202E\u2066-\u2069]/

const HANGUL_CONJOINING_RE = /[\u1160-\u11FF]/

const EMOJI_TRIGGER_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/u

const EMOJI_CLUSTER_RE = (() => {
  const vendored = emojiRegexFactory()
  return new RegExp(`^(?:${vendored.source})$`, vendored.flags.replace('g', ''))
})()

function isControlOrFormat(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    within(codePoint, 0x7f, 0x9f) ||
    codePoint === 0xad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    within(codePoint, 0x200b, 0x200f) ||
    within(codePoint, 0x202a, 0x202e) ||
    within(codePoint, 0x2060, 0x2069) ||
    codePoint === 0xfeff
  )
}

function isHangulOrSelector(codePoint: number): boolean {
  return within(codePoint, 0x1160, 0x11ff) || within(codePoint, 0xfe00, 0xfe0f) || within(codePoint, 0xe0100, 0xe01ef)
}

function isCombining(codePoint: number): boolean {
  return (
    within(codePoint, 0x0300, 0x036f) ||
    within(codePoint, 0x1ab0, 0x1aff) ||
    within(codePoint, 0x1dc0, 0x1dff) ||
    within(codePoint, 0x20d0, 0x20ff) ||
    within(codePoint, 0xfe20, 0xfe2f) ||
    isHebrewArabicCombiningMark(codePoint)
  )
}

function isIndicSign(codePoint: number): boolean {
  if (!within(codePoint, 0x0900, 0x0d4f)) return false
  const place = codePoint & 0x7f
  return place <= 0x03 || within(place, 0x3a, 0x4f) || within(place, 0x51, 0x57) || within(place, 0x62, 0x63)
}

function isThaiOrLaoMark(codePoint: number): boolean {
  return (
    codePoint === 0x0e31 ||
    within(codePoint, 0x0e34, 0x0e3a) ||
    within(codePoint, 0x0e47, 0x0e4e) ||
    codePoint === 0x0eb1 ||
    within(codePoint, 0x0eb4, 0x0ebc) ||
    within(codePoint, 0x0ec8, 0x0ecd)
  )
}

function isStrayOrFormatSign(codePoint: number): boolean {
  return (
    within(codePoint, 0x0600, 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2 ||
    within(codePoint, 0xd800, 0xdfff) ||
    within(codePoint, 0xe0000, 0xe007f)
  )
}

function cellsOfCodePoint(codePoint: number): number {
  if (within(codePoint, 0x20, 0x7e)) return 1
  if (codePoint === 0x200c || codePoint === 0x200d) return terminalTextCells().joinerCells
  if (
    isControlOrFormat(codePoint) ||
    isHangulOrSelector(codePoint) ||
    isCombining(codePoint) ||
    isIndicSign(codePoint) ||
    isThaiOrLaoMark(codePoint) ||
    isStrayOrFormatSign(codePoint)
  ) {
    return 0
  }
  return eastAsianWidth(codePoint)
}

function cellsOfCodePoints(text: string): number {
  let cells = 0
  for (let at = 0; at < text.length; at++) {
    const codePoint = text.codePointAt(at)!
    if (codePoint > 0xffff) at++
    cells += cellsOfCodePoint(codePoint)
  }
  return cells
}

const KEYCAP_BASE_WITH_SELECTOR_RE = /^[0-9#*]\ufe0f$/

function cellsOfEmoji(cluster: string): number {
  const first = cluster.codePointAt(0)!
  const alone = cluster.length === (first > 0xffff ? 2 : 1)
  if (within(first, 0x1f1e6, 0x1f1ff)) return alone ? 1 : 2
  if (KEYCAP_BASE_WITH_SELECTOR_RE.test(cluster)) return 1
  if (alone && eastAsianWidth(first) === 1) return 1
  return 2
}

function correctedWidth(text: string): number {
  if (!EMOJI_TRIGGER_RE.test(text)) return cellsOfCodePoints(text)
  let cells = 0
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    cells += EMOJI_CLUSTER_RE.test(segment) ? cellsOfEmoji(segment) : cellsOfCodePoints(segment)
  }
  return cells
}

export const __correctedWidthForTest = correctedWidth

export function stringWidth(input: string): number {
  if (typeof input !== 'string' || input === '') return 0
  let cells = 0
  let plainAscii = true
  for (let at = 0; at < input.length; at++) {
    const unit = input.charCodeAt(at)
    if (unit >= 127 || unit === 0x1b) {
      plainAscii = false
      break
    }
    if (unit >= 0x20) cells++
  }
  if (plainAscii) return cells
  const text = input.includes('\x1b') ? stripAnsi(input) : input
  if (text === '') return 0
  if (nativeStringWidth && !HEBREW_ARABIC_MARK_RE.test(text) && !DIRECTIONAL_FORMAT_RE.test(text) && !HANGUL_CONJOINING_RE.test(text)) {
    return nativeStringWidth(text, { countAnsiEscapeCodes: false, ambiguousIsNarrow: true })
  }
  return correctedWidth(text)
}
