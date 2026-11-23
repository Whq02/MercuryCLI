import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'

const URL_DELIMITERS = '<>"\'`'
const TRAILING_PUNCT = '.,;:!?'
const CLOSING_PAIR: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' }
const URL_SCHEME = /(?:https?|file):\/\//g

function urlCell(screen: Screen, col: number, row: number, requireNarrow: boolean): string | undefined {
  if (screen.noSelect[row * screen.width + col] === 1) return undefined
  const cell = cellAt(screen, col, row)
  if (!cell || (requireNarrow && cell.width !== CellWidth.Narrow)) return undefined
  const text = cell.char
  if (text.length !== 1 || text < '!' || text > '~' || URL_DELIMITERS.includes(text)) return undefined
  return text
}

function hasNegativeBalance(text: string, opener: string, closer: string): boolean {
  let balance = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === opener) balance++
    else if (ch === closer) balance--
  }
  return balance < 0
}

function trimTrailingPunctuation(raw: string): string {
  let text = raw
  while (text.length > 0) {
    const last = text[text.length - 1]!
    if (TRAILING_PUNCT.includes(last)) {
      text = text.slice(0, -1)
      continue
    }
    const opener = CLOSING_PAIR[last]
    if (opener !== undefined && hasNegativeBalance(text, opener, last)) {
      text = text.slice(0, -1)
      continue
    }
    break
  }
  return text
}

export function findPlainTextUrlAt(
  screen: Screen,
  col: number,
  row: number,
): string | undefined {
  if (row < 0 || row >= screen.height || col < 0 || col >= screen.width) return undefined
  let clicked = col
  const cell = cellAt(screen, clicked, row)
  if (!cell) return undefined
  if (cell.width === CellWidth.SpacerTail && clicked > 0) clicked--
  if (urlCell(screen, clicked, row, false) === undefined) return undefined

  let left = clicked
  while (left > 0 && urlCell(screen, left - 1, row, true) !== undefined) left--
  let right = clicked
  while (right + 1 < screen.width && urlCell(screen, right + 1, row, true) !== undefined) right++

  let run = ''
  for (let c = left; c <= right; c++) {
    run += cellAt(screen, c, row)!.char
  }

  const offset = clicked - left
  let start = -1
  let end = run.length
  for (const match of run.matchAll(URL_SCHEME)) {
    const idx = match.index
    if (idx <= offset) {
      start = idx
    } else {
      end = idx
      break
    }
  }
  if (start < 0) return undefined

  const trimmed = trimTrailingPunctuation(run.slice(start, end))
  return offset - start < trimmed.length ? trimmed : undefined
}
