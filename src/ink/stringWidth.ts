
import emojiRegexFactory from 'emoji-regex'
import { eastAsianWidth } from 'get-east-asian-width'
import stripAnsi from 'strip-ansi'
import { getGraphemeSegmenter } from '../utils/intl.js'

type NativeStringWidth = (
  input: string,
  options?: { countAnsiEscapeCodes?: boolean; ambiguousIsNarrow?: boolean },
) => number

const nativeStringWidth: NativeStringWidth | undefined = (
  globalThis as { Bun?: { stringWidth?: NativeStringWidth } }
).Bun?.stringWidth

export function isHebrewArabicCombiningMark(codePoint: number): boolean {
  if (codePoint >= 0x0591 && codePoint <= 0x05bd) return true
  if (
    codePoint === 0x05bf ||
    codePoint === 0x05c1 ||
    codePoint === 0x05c2 ||
    codePoint === 0x05c4 ||
    codePoint === 0x05c5 ||
    codePoint === 0x05c7
  ) {
    return true
  }
  if (codePoint >= 0x064b && codePoint <= 0x065f) return true
  return codePoint === 0x0670
}

const HEBREW_ARABIC_MARK_RE =
  /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u064B-\u065F\u0670]/

const DIRECTIONAL_FORMAT_RE = /[\u061C\u180E\u200E\u200F\u202A-\u202E\u2066-\u2069]/

function isZeroWidthCodePoint(codePoint: number): boolean {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return false
  if (codePoint <= 0x1f) return true
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true
  if (codePoint >= 0xa0 && codePoint <= 0x2ff) return codePoint === 0xad
  if (codePoint >= 0x200b && codePoint <= 0x200f) return true
  if (codePoint === 0xfeff) return true
  if (codePoint >= 0x2060 && codePoint <= 0x2069) return true
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true
  if (codePoint === 0x061c || codePoint === 0x180e) return true
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return true
  if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) return true
  if (codePoint >= 0x300 && codePoint <= 0x36f) return true
  if (codePoint >= 0x1ab0 && codePoint <= 0x1aff) return true
  if (codePoint >= 0x1dc0 && codePoint <= 0x1dff) return true
  if (codePoint >= 0x20d0 && codePoint <= 0x20ff) return true
  if (codePoint >= 0xfe20 && codePoint <= 0xfe2f) return true
  if (isHebrewArabicCombiningMark(codePoint)) return true
  if (codePoint >= 0x900 && codePoint <= 0xd4f) {
    const offset = codePoint & 0x7f
    if (
      offset <= 0x03 ||
      (offset >= 0x3a && offset <= 0x4f) ||
      (offset >= 0x51 && offset <= 0x57) ||
      (offset >= 0x62 && offset <= 0x63)
    ) {
      return true
    }
  }
  if (codePoint === 0x0e31) return true
  if (codePoint >= 0x0e34 && codePoint <= 0x0e3a) return true
  if (codePoint >= 0x0e47 && codePoint <= 0x0e4e) return true
  if (codePoint === 0x0eb1) return true
  if (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) return true
  if (codePoint >= 0x0ec8 && codePoint <= 0x0ecd) return true
  if (codePoint >= 0x600 && codePoint <= 0x605) return true
  if (codePoint === 0x6dd || codePoint === 0x70f || codePoint === 0x8e2) return true
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true
  return false
}

const EMOJI_TRIGGER_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/u

const EMOJI_CLUSTER_RE = (() => {
  const vendored = emojiRegexFactory()
  return new RegExp(`^(?:${vendored.source})$`, vendored.flags.replace('g', ''))
})()

function emojiClusterWidth(cluster: string, firstCodePoint: number): number {
  if (firstCodePoint >= 0x1f1e6 && firstCodePoint <= 0x1f1ff) {
    let count = 0
    for (const _ of cluster) count++
    return count === 1 ? 1 : 2
  }
  const codePoints: number[] = []
  for (const ch of cluster) codePoints.push(ch.codePointAt(0)!)
  if (
    codePoints.length === 2 &&
    codePoints[1] === 0xfe0f &&
    ((firstCodePoint >= 0x30 && firstCodePoint <= 0x39) ||
      firstCodePoint === 0x23 ||
      firstCodePoint === 0x2a)
  ) {
    return 1
  }
  if (codePoints.length === 1 && eastAsianWidth(firstCodePoint) === 1) return 1
  return 2
}

function clusterWidth(cluster: string): number {
  const firstCodePoint = cluster.codePointAt(0)!
  if (EMOJI_CLUSTER_RE.test(cluster)) {
    return emojiClusterWidth(cluster, firstCodePoint)
  }
  let width = 0
  for (const ch of cluster) {
    const codePoint = ch.codePointAt(0)!
    if (isZeroWidthCodePoint(codePoint)) continue
    width += eastAsianWidth(codePoint)
  }
  return width
}

function correctedWidth(text: string): number {
  if (!EMOJI_TRIGGER_RE.test(text)) {
    let width = 0
    for (const ch of text) {
      const codePoint = ch.codePointAt(0)!
      if (isZeroWidthCodePoint(codePoint)) continue
      width += eastAsianWidth(codePoint)
    }
    return width
  }
  const segmenter = getGraphemeSegmenter()
  let width = 0
  for (const { segment } of segmenter.segment(text)) {
    width += clusterWidth(segment)
  }
  return width
}

export const __correctedWidthForTest = correctedWidth

export function stringWidth(input: string): number {
  if (typeof input !== 'string' || input.length === 0) return 0

  let asciiOnly = true
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code >= 127 || code === 0x1b) {
      asciiOnly = false
      break
    }
  }
  if (asciiOnly) {
    let width = 0
    for (let i = 0; i < input.length; i++) {
      if (input.charCodeAt(i) >= 0x20) width++
    }
    return width
  }

  let text = input
  if (text.includes('\x1b')) {
    text = stripAnsi(text)
    if (text.length === 0) return 0
  }

  if (nativeStringWidth && !HEBREW_ARABIC_MARK_RE.test(text) && !DIRECTIONAL_FORMAT_RE.test(text)) {
    return nativeStringWidth(text, {
      countAnsiEscapeCodes: false,
      ambiguousIsNarrow: true,
    })
  }
  return correctedWidth(text)
}
