

const START_SHORTHAND = /^\s*\+(\d+(?:\.\d+)?)\s*([kmb])\b/i
const END_SHORTHAND = /\s\+(\d+(?:\.\d+)?)\s*([kmb])\s*[.!?]?\s*$/i
const VERBOSE_SOURCE = String.raw`\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*([kmb])\s*tokens?\b`


export function findTokenBudgetPositions(text: string): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []

  const start = text.match(START_SHORTHAND)
  if (start) {
    const leadingWhitespace = start[0].length - start[0].trimStart().length
    positions.push({ start: leadingWhitespace, end: start[0].length })
  }

  const end = END_SHORTHAND.exec(text)
  if (end && end.index !== undefined) {
    const spanStart = end.index + 1
    const covered = positions.some(span => spanStart >= span.start && spanStart < span.end)
    if (!covered) {
      positions.push({ start: spanStart, end: end.index + end[0].length })
    }
  }

  const verboseGlobal = new RegExp(VERBOSE_SOURCE, 'gi')
  for (const match of text.matchAll(verboseGlobal)) {
    if (match.index === undefined) continue
    positions.push({ start: match.index, end: match.index + match[0].length })
  }

  return positions
}
