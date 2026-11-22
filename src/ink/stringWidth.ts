import emojiRegexFactory from 'emoji-regex'
import { eastAsianWidth } from 'get-east-asian-width'
import stripAnsi from 'strip-ansi'
import { getGraphemeSegmenter } from '../utils/intl.js'
import { terminalTextCells } from './session/terminalTextCells.js'
import { notBuilt } from '../pi/holes.js'

type NativeStringWidth = (
  input: string,
  options?: { countAnsiEscapeCodes?: boolean; ambiguousIsNarrow?: boolean },
) => number

const nativeStringWidth: NativeStringWidth | undefined = (
  globalThis as { Bun?: { stringWidth?: NativeStringWidth } }
).Bun?.stringWidth

export function isHebrewArabicCombiningMark(codePoint: number): boolean {
  return notBuilt('src/ink/stringWidth.ts:17')
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

function correctedWidth(text: string): number {
  return notBuilt('src/ink/stringWidth.ts:126')
}

export const __correctedWidthForTest = correctedWidth

export function stringWidth(input: string): number {
  return notBuilt('src/ink/stringWidth.ts:146')
}
