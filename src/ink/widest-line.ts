// Widest display width across the lines of a string, including a trailing
// empty segment when the string ends with a newline.

import { lineWidth } from './line-width-cache.js'

export function widestLine(string: string): number {
  let widest = 0
  let start = 0
  for (;;) {
    const newline = string.indexOf('\n', start)
    const line = newline === -1 ? string.slice(start) : string.slice(start, newline)
    const width = lineWidth(line)
    if (width > widest) widest = width
    if (newline === -1) return widest
    start = newline + 1
  }
}
