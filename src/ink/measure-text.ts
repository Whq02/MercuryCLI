// Single-pass width + wrapped-height measurement of a multi-line string.

import { lineWidth } from './line-width-cache.js'

export default function measureText(
  text: string,
  maxWidth: number,
): { width: number; height: number } {
  if (text.length === 0) return { width: 0, height: 0 }

  // With no usable wrap constraint, each newline-delimited line contributes
  // exactly 1 to height. This check must run BEFORE the loop.
  const unconstrained = maxWidth <= 0 || !Number.isFinite(maxWidth)

  let width = 0
  let height = 0
  let start = 0
  for (;;) {
    const newline = text.indexOf('\n', start)
    const line = newline === -1 ? text.slice(start) : text.slice(start, newline)
    const w = lineWidth(line)
    if (w > width) width = w
    if (unconstrained) height += 1
    else height += w === 0 ? 1 : Math.ceil(w / maxWidth)
    if (newline === -1) break
    start = newline + 1
  }
  return { width, height }
}
