import { reduceAnsiCodes, tokenize, undoAnsiCodes, type AnsiCode } from '@alcalzone/ansi-tokenize'

import { stringWidth } from '../ink/stringWidth.js'

/**
 * Display-cell-accurate slicing of ANSI-styled strings — hyperlink- and
 * combining-mark-safe, styling preserved.
 *
 * The tokeniser runs over the WHOLE string: its end bound is in code units,
 * and combining marks make code units exceed cells, so a code-unit limit
 * derived from a cell count would stop the stream early.
 */
export default function sliceAnsi(str: string, start: number, end?: number): string {
  const tokens = tokenize(str)
  const bound = end ?? Infinity

  const pieces: string[] = []
  const accumulated: AnsiCode[] = []
  let active: AnsiCode[] = []
  let cell = 0
  let included = false

  const widthOf = (token: (typeof tokens)[number]): number => {
    if (token.type === 'ansi' || token.type === 'control') return 0
    if (token.fullWidth) return 2
    return stringWidth(token.value)
  }

  for (const token of tokens) {
    const width = widthOf(token)
    if (token.type === 'control') {
      // A non-styling control sequence (a window title, a notification):
      // zero cells and no style state — carried verbatim inside the slice,
      // never taken at the boundary.
      if (cell >= bound) break
      if (included) pieces.push(token.code)
      continue
    }
    if (cell + width > bound && token.type !== 'ansi') {
      if (width > 0) break
      // A zero-width mark past the end bound belongs to the previous
      // character's grapheme — take it, unless nothing has been included
      // (a slice whose start equals its end stays empty even when the
      // string opens with a zero-width character).
      if (!included) break
      pieces.push(token.value)
      continue
    }
    if (token.type === 'ansi') {
      if (cell >= bound) {
        // At the boundary an escape must NOT be taken: it opens a style run
        // that the trailing reset would close, corrupting the styling.
        break
      }
      if (included) {
        pieces.push(token.code)
        active.push(token)
        active = reduceAnsiCodes(active)
      } else {
        accumulated.push(token)
      }
      continue
    }
    if (cell + width <= start) {
      cell += width
      continue
    }
    if (cell < start && cell + width > start) {
      // A wide character straddling the start is skipped entirely.
      cell += width
      continue
    }
    if (!included && width === 0 && start > 0) {
      // A zero-width mark AT the start boundary attaches to the character
      // just before it — the caller's LEFT slice already holds it; taking
      // it here would duplicate it across the halves. At start zero there
      // is no preceding character.
      cell += width
      continue
    }
    if (!included) {
      // First inclusion: the accumulated codes reduce and filter to active
      // START codes, emitted as the slice's opening styles.
      active = reduceAnsiCodes(accumulated).filter(code => code.code !== code.endCode)
      for (const code of active) pieces.push(code.code)
      included = true
    }
    pieces.push(token.value)
    cell += width
  }

  if (included) {
    // Close with the undo sequences for the still-active start codes only;
    // self-ending codes (a hyperlink close) are excluded from both sets.
    const open = active.filter(code => code.code !== code.endCode)
    for (const code of undoAnsiCodes(open)) pieces.push(code.code)
  }
  return pieces.join('')
}
