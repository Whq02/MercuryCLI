export function findTokenBudgetPositions(text: string): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  const head = /^\s*\+\d+(?:\.\d+)?\s*[kmb]\b/i.exec(text)
  if (head) positions.push({ start: head[0].indexOf('+'), end: head[0].length })
  const tail = /\s\+\d+(?:\.\d+)?\s*[kmb]\s*(?:[.!?]\s*)?$/i.exec(text)
  if (tail && tail.index + 1 >= (head?.[0].length ?? 0)) {
    positions.push({ start: tail.index + 1, end: text.length })
  }
  for (const match of text.matchAll(/\b(?:use|spend)\s+\d+(?:\.\d+)?\s*[kmb]\s*tokens?\b/gi)) {
    positions.push({ start: match.index, end: match.index + match[0].length })
  }
  return positions
}
