import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'

const URL_DELIMITERS = '<>"\'`'
const CLOSING_PAIR: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' }

function urlCell(screen: Screen, col: number, row: number, requireNarrow: boolean): string | undefined {
  if (screen.noSelect[row * screen.width + col] === 1) return undefined
  const cell = cellAt(screen, col, row)
  if (!cell || (requireNarrow && cell.width !== CellWidth.Narrow)) return undefined
  const text = cell.char
  if (text.length !== 1 || text < '!' || text > '~' || URL_DELIMITERS.includes(text)) return undefined
  return text
}

function urlRightEdge(text: string): number {
  let end = text.length
  while (end > 0) {
    const closer = text[end - 1]!
    if ('.,;:!?'.includes(closer)) {
      end--
      continue
    }
    const opener = CLOSING_PAIR[closer]
    if (!opener) break
    let balance = 0
    for (let index = 0; index < end; index++) {
      if (text[index] === opener) balance++
      else if (text[index] === closer) balance--
    }
    if (balance >= 0) break
    end--
  }
  return end
}

export function findPlainTextUrlAt(
  screen: Screen,
  col: number,
  row: number,
): string | undefined {
  if (row < 0 || row >= screen.height) return undefined
  const clicked = col > 0 && cellAt(screen, col, row)?.width === CellWidth.SpacerTail ? col - 1 : col
  if (clicked < 0 || clicked >= screen.width || urlCell(screen, clicked, row, false) === undefined) {
    return undefined
  }
  let left = clicked
  let right = clicked
  while (left > 0 && urlCell(screen, left - 1, row, true) !== undefined) left--
  while (right + 1 < screen.width && urlCell(screen, right + 1, row, true) !== undefined) right++
  let run = ''
  for (let index = left; index <= right; index++) run += cellAt(screen, index, row)!.char
  const offset = clicked - left
  let start: number | undefined
  let end = run.length
  for (const match of run.matchAll(/(?:https?|file):\/\//g)) {
    if (match.index > offset) {
      end = match.index
      break
    }
    start = match.index
  }
  if (start === undefined) return undefined
  const candidate = run.slice(start, end)
  const length = urlRightEdge(candidate)
  return offset < start + length ? candidate.slice(0, length) : undefined
}
