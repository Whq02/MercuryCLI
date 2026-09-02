/* keywordTrigger/supercode
   (compat-src parity batch 5 chunk F, #74; origin utils/ultraplan/keyword.ts).

   The inline keyword-trigger detector: finds launch-directive keyword positions in a
   draft prompt while SKIPPING occurrences that are clearly NOT a directive — quoted /
   delimited spans, path/identifier contexts, questions about the feature, and slash-
   command input. The paired-delimiter scanner (incl. the apostrophe and tag-like `<`
   rules) is generalized over the keyword.

   Mercury's live keyword is `supercode` (the SDK's dynamic-workflow opt-in; the
   ultraplan wrappers kept for the plan-mode launch keyword). This module is PURE:
   zero deps, framework-agnostic (no React, no Ink, no DOM), and never throws — every
   entry point tolerates junk input and returns an empty result. It is the logic that
   feeds the `supercodeKeywordHint` TUI surface and the /effort command's hint
   rendering; the rendering lives in components, never here.
*/

export type TriggerPosition = { word: string; start: number; end: number }

const OPEN_TO_CLOSE: Record<string, string> = {
  '`': '`',
  '"': '"',
  '<': '>',
  '{': '}',
  '[': ']',
  '(': ')',
  "'": "'",
}

/**
 * Find keyword positions, skipping occurrences that are clearly not a launch directive
 * (see the source-doc rules):
 *  - inside paired delimiters (backticks, quotes, tag-like `<…>`, braces, brackets,
 *    parens; single quotes only when not an apostrophe);
 *  - path/identifier context (`/`, `\`, `-` adjacency, or a `.ext` suffix);
 *  - followed by `?` (a question about the feature, not an invocation);
 *  - slash-command input (a leading `/` routes to the slash processor instead).
 *
 * Generic over `keyword`. Case-insensitive, word-boundary matched. Returns the matched
 * spans with exact `[start, end)` offsets into `text`.
 */
export function findKeywordTriggerPositions(text: string, keyword: string): TriggerPosition[] {
  if (typeof text !== 'string' || typeof keyword !== 'string' || !keyword) return []
  const re = new RegExp(keyword, 'i')
  if (!re.test(text)) return []
  if (text.startsWith('/')) return []
  const quotedRanges: Array<{ start: number; end: number }> = []
  let openQuote: string | null = null
  let openAt = 0
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (openQuote) {
      if (openQuote === '[' && ch === '[') {
        openAt = i // innermost bracket — preExpansionInput carries [Pasted text #N] placeholders
        continue
      }
      if (ch !== OPEN_TO_CLOSE[openQuote]) continue
      if (openQuote === "'" && isWord(text[i + 1])) continue // closing quote of an apostrophe-word
      quotedRanges.push({ start: openAt, end: i + 1 })
      openQuote = null
    } else if (
      (ch === '<' && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1]!)) || // tag-like only
      (ch === "'" && !isWord(text[i - 1])) || // an opening quote, not an apostrophe
      (ch !== '<' && ch !== "'" && ch in OPEN_TO_CLOSE)
    ) {
      openQuote = ch
      openAt = i
    }
  }

  const positions: TriggerPosition[] = []
  const wordRe = new RegExp(`\\b${keyword}\\b`, 'gi')
  const matches = text.matchAll(wordRe)
  for (const match of matches) {
    if (match.index === undefined) continue
    const start = match.index
    const end = start + match[0].length
    if (quotedRanges.some((r) => start >= r.start && start < r.end)) continue
    const before = text[start - 1]
    const after = text[end]
    if (before === '/' || before === '\\' || before === '-') continue
    if (after === '/' || after === '\\' || after === '-' || after === '?') continue
    if (after === '.' && isWord(text[end + 1])) continue // file extension
    positions.push({ word: match[0], start, end })
  }
  return positions
}

/** Mercury's LIVE keyword: `supercode` opts a turn into the engine's dynamic-workflow
 *  runtime (the SDK workflowKeywordTriggerEnabled surface). */
export function findSupercodeTriggerPositions(text: string): TriggerPosition[] {
  return findKeywordTriggerPositions(text, 'supercode')
}
export function hasSupercodeKeyword(text: string): boolean {
  return findSupercodeTriggerPositions(text).length > 0
}

/* Parity wrapper for the plan-mode launch keyword. */
export function findUltraplanTriggerPositions(text: string): TriggerPosition[] {
  return findKeywordTriggerPositions(text, 'ultraplan')
}
export function hasUltraplanKeyword(text: string): boolean {
  return findUltraplanTriggerPositions(text).length > 0
}

/** replaceUltraplanKeyword: swap the first triggerable "ultraplan" for "plan" so a
 *  forwarded prompt stays grammatical; preserves the user's casing of the suffix. */
export function replaceUltraplanKeyword(text: string): string {
  const [trigger] = findUltraplanTriggerPositions(text)
  if (!trigger) return text
  const before = text.slice(0, trigger.start)
  const after = text.slice(trigger.end)
  if (!(before + after).trim()) return ''
  return before + trigger.word.slice('ultra'.length) + after
}
