import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'
import { notBuilt } from '../../pi/holes.js'

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

export function findPlainTextUrlAt(
  screen: Screen,
  col: number,
  row: number,
): string | undefined {
  return notBuilt('src/ink/geometry/url.ts:37')
}
