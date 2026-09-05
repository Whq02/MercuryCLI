import type { HexColor } from '../ink/styles.js'
import { findSupercodeTriggerPositions, type TriggerPosition } from './keywordTrigger/supercode.js'
import type { TextHighlight } from './textHighlighting.js'
import { findThinkingTriggerPositions } from './thinking.js'

export type KeywordGlowWord = 'deepthink' | 'supercode'

export type KeywordGlowPosition = TriggerPosition & { kind: KeywordGlowWord }

export type KeywordGlowPaint = { accent: string; accentSoft: string }

export type KeywordGlowWords = { deepthink: boolean; supercode: boolean }

const HEX_RE = /^#[0-9a-fA-F]{6}$/

export function keywordGlowHex(value: string): HexColor | undefined {
  return HEX_RE.test(value) ? (value as HexColor) : undefined
}

export function keywordGlowPositions(text: string, words: KeywordGlowWords): KeywordGlowPosition[] {
  const out: KeywordGlowPosition[] = []
  if (words.deepthink) {
    for (const p of findThinkingTriggerPositions(text)) out.push({ ...p, kind: 'deepthink' })
  }
  if (words.supercode) {
    for (const p of findSupercodeTriggerPositions(text)) out.push({ ...p, kind: 'supercode' })
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end)
  return out
}

export function keywordGlowSpans(
  text: string,
  paint: KeywordGlowPaint,
  words: KeywordGlowWords,
  opts: { priority?: number; shimmer?: boolean } = {},
): TextHighlight[] {
  const accent = keywordGlowHex(paint.accent)
  if (accent === undefined) return []
  const soft = keywordGlowHex(paint.accentSoft) ?? accent
  const priority = opts.priority ?? 10
  const shimmer = opts.shimmer ?? true
  return keywordGlowPositions(text, words).map(p => ({
    start: p.start,
    end: p.end,
    color: accent,
    ...(shimmer ? { shimmerColor: soft } : {}),
    priority,
  }))
}
