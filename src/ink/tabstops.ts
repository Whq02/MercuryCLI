
import { createScanner } from './input/scanner.js'
import { stringWidth } from './stringWidth.js'

export function expandTabsWithColumn(
  text: string,
  startColumn: number,
  interval = 8,
): { text: string; column: number } {
  if (!text.includes('\t')) {
    const lastBreak = text.lastIndexOf('\n')
    const tail = lastBreak === -1 ? text : text.slice(lastBreak + 1)
    return {
      text,
      column: (lastBreak === -1 ? startColumn : 0) + stringWidth(tail),
    }
  }

  const scanner = createScanner()
  const tokens = [...scanner.feed(text), ...scanner.flush()]
  let out = ''
  let column = startColumn
  for (const token of tokens) {
    if (token.kind !== 'text') {
      out += token.value
      continue
    }
    let run = ''
    const flushRun = (): void => {
      if (run) {
        out += run
        column += stringWidth(run)
        run = ''
      }
    }
    for (const ch of token.value) {
      if (ch === '\t') {
        flushRun()
        const spaces = interval - (column % interval) || interval
        out += ' '.repeat(spaces)
        column += spaces
      } else if (ch === '\n') {
        flushRun()
        out += '\n'
        column = 0
      } else {
        run += ch
      }
    }
    flushRun()
  }
  return { text: out, column }
}

export function expandTabs(text: string, interval = 8): string {
  return expandTabsWithColumn(text, 0, interval).text
}
