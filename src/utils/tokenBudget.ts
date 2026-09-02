/**
 * Parses an operator instruction to spend a given number of tokens on a
 * turn. The shorthand forms are anchored at the ends of the text to avoid
 * false positives in prose; the verbose form matches anywhere.
 */

const UNIT_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
}

// Start-of-text shorthand: optional whitespace, `+`, a number, optional
// whitespace, a unit on a word boundary.
const START_SHORTHAND = /^\s*\+(\d+(?:\.\d+)?)\s*([kmb])\b/i
// End-of-text shorthand. The leading whitespace is REQUIRED and captured
// as part of the match rather than via a look-behind — a look-behind
// prevents the engine from compiling the pattern and forces a linear
// scan — so position-sensitive callers offset the match index by one.
const END_SHORTHAND = /\s\+(\d+(?:\.\d+)?)\s*([kmb])\s*[.!?]?\s*$/i
// Verbose form, matching anywhere.
const VERBOSE_SOURCE = String.raw`\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*([kmb])\s*tokens?\b`
const VERBOSE = new RegExp(VERBOSE_SOURCE, 'i')

function budgetFromMatch(match: RegExpMatchArray): number {
  const amount = parseFloat(match[1] as string)
  const unit = (match[2] as string).toLowerCase()
  return amount * (UNIT_MULTIPLIERS[unit] as number)
}

/** The first match in the order start-shorthand, end-shorthand, verbose; null when none match. */
export function parseTokenBudget(text: string): number | null {
  const start = text.match(START_SHORTHAND)
  if (start) return budgetFromMatch(start)
  const end = text.match(END_SHORTHAND)
  if (end) return budgetFromMatch(end)
  const verbose = text.match(VERBOSE)
  if (verbose) return budgetFromMatch(verbose)
  return null
}

/** Every highlightable span. The list is not sorted. */
export function findTokenBudgetPositions(text: string): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []

  const start = text.match(START_SHORTHAND)
  if (start) {
    // The span begins after any leading whitespace the anchored match
    // swallowed.
    const leadingWhitespace = start[0].length - start[0].trimStart().length
    positions.push({ start: leadingWhitespace, end: start[0].length })
  }

  const end = END_SHORTHAND.exec(text)
  if (end && end.index !== undefined) {
    // Offset past the captured whitespace character; skip the span when it
    // already lies inside a recorded one, or a lone `+500k` would be
    // recorded twice.
    const spanStart = end.index + 1
    const covered = positions.some(span => spanStart >= span.start && spanStart < span.end)
    if (!covered) {
      positions.push({ start: spanStart, end: end.index + end[0].length })
    }
  }

  // A FRESH global pattern per call: the match-all API seeds itself from
  // the pattern's stored last-index, so a shared instance would let one
  // call displace the next call's reported positions.
  const verboseGlobal = new RegExp(VERBOSE_SOURCE, 'gi')
  for (const match of text.matchAll(verboseGlobal)) {
    if (match.index === undefined) continue
    positions.push({ start: match.index, end: match.index + match[0].length })
  }

  return positions
}
