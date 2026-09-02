import { reduceAnsiCodes, tokenize, undoAnsiCodes, type AnsiCode } from '@alcalzone/ansi-tokenize'

import { stringWidth } from '../ink/stringWidth.js'

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
      if (cell >= bound) break
      if (included) pieces.push(token.code)
      continue
    }
    if (cell + width > bound && token.type !== 'ansi') {
      if (width > 0) break
      if (!included) break
      pieces.push(token.value)
      continue
    }
    if (token.type === 'ansi') {
      if (cell >= bound) {
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
      cell += width
      continue
    }
    if (!included && width === 0 && start > 0) {
      cell += width
      continue
    }
    if (!included) {
      active = reduceAnsiCodes(accumulated).filter(code => code.code !== code.endCode)
      for (const code of active) pieces.push(code.code)
      included = true
    }
    pieces.push(token.value)
    cell += width
  }

  if (included) {
    const open = active.filter(code => code.code !== code.endCode)
    for (const code of undoAnsiCodes(open)) pieces.push(code.code)
  }
  return pieces.join('')
}
