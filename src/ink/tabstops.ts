// Tab expansion to fixed-interval stops (default 8, the POSIX default
// terminals hard-code), ANSI-aware: escape tokens pass through verbatim
// without advancing the column counter.
//
// ONE arithmetic owner (FN-016 R4): every consumer — layout's worst-case
// measure (dom.ts), the compositor's per-segment pre-expansion
// (compose-walk), and the buffer's raw-ansi backstop — counts stops through
// the walk below. The column origin is the TEXT's own column 0 (resetting
// at newlines), never the absolute screen column: stops must land
// identically at the wrap decision, in the reserved layout height and in
// the painted cells, and a gutter-indented pane must keep its code's own
// alignment.

import { createScanner } from './input/scanner.js'
import { stringWidth } from './stringWidth.js'

/** Expand from a caller-supplied starting column; returns the expanded text
 *  and the column after it (for a walk over consecutive segments of ONE
 *  line of text — the compositor's styled-segment pre-pass). */
export function expandTabsWithColumn(
  text: string,
  startColumn: number,
  interval = 8,
): { text: string; column: number } {
  if (!text.includes('\t')) {
    // Column still advances (a later segment's tab depends on it); the
    // last newline resets the origin.
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
        // Never zero spaces: a tab AT a stop advances a full interval.
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
