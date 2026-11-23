import { createScanner, type ScanToken } from './input/scanner.js'
import { stringWidth } from './stringWidth.js'

export function expandTabsWithColumn(
  text: string,
  startColumn: number,
  interval = 8,
): { text: string; column: number } {
  if (!text.includes('\t')) {
    const lineFeed = text.lastIndexOf('\n')
    return { text, column: lineFeed === -1 ? startColumn + stringWidth(text) : stringWidth(text.slice(lineFeed + 1)) }
  }
  const scanner = createScanner()
  const tokens: ScanToken[] = [...scanner.feed(text), ...scanner.flush()]
  let expanded = ''
  let column = startColumn
  for (const token of tokens) {
    if (token.kind !== 'text') {
      expanded += token.value
      continue
    }
    for (const run of token.value.split(/(\t|\n)/)) {
      if (run === '\t') {
        const spaces = interval - (column % interval)
        expanded += ' '.repeat(spaces)
        column += spaces
      } else if (run === '\n') {
        expanded += run
        column = 0
      } else if (run !== '') {
        expanded += run
        column += stringWidth(run)
      }
    }
  }
  return { text: expanded, column }
}

export function expandTabs(text: string, interval = 8): string {
  return expandTabsWithColumn(text, 0, interval).text
}
