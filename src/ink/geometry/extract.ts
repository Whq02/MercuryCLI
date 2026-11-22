import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'
import { selectionBounds, type SelectionState } from './selection-model.js'
import { notBuilt } from '../../pi/holes.js'

export function extractRowText(
  screen: Screen,
  row: number,
  colStart: number,
  colEnd: number,
): string {
  return notBuilt('src/ink/geometry/extract.ts:5')
}

export function joinRows(lines: string[], text: string, sw: boolean | undefined): void {
  const previous = lines.length - 1
  if (!sw || previous < 0) lines.push(text)
  else lines[previous] += text
}

function appendCaptured(lines: string[], rows: readonly string[], joins: readonly boolean[]): void {
  for (let index = 0; index < rows.length; index++) joinRows(lines, rows[index]!, joins[index])
}

export function getSelectedText(s: SelectionState, screen: Screen): string {
  return notBuilt('src/ink/geometry/extract.ts:33')
}
