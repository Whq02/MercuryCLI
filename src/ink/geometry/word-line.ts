import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'
import { clamp } from '../layout/geometry.js'
import { comparePoints, type Point, type SelectionState } from './selection-model.js'
import { notBuilt } from '../../pi/holes.js'

const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u

function charClass(text: string): 0 | 1 | 2 {
  return text === ' ' || text === '' ? 0 : WORD_CHAR.test(text) ? 1 : 2
}

function runEdge(screen: Screen, row: number, origin: number, step: -1 | 1, kind: number): number {
  const rowStart = row * screen.width
  let edge = origin
  while (true) {
    let next = edge + step
    if (next < 0 || next >= screen.width || screen.noSelect[rowStart + next] === 1) return edge
    let cell = cellAt(screen, next, row)
    if (!cell) return edge
    if (cell.width === CellWidth.SpacerTail) {
      if (step === 1) {
        edge = next
        continue
      }
      next--
      if (next < 0 || screen.noSelect[rowStart + next] === 1) return edge
      cell = cellAt(screen, next, row)
      if (!cell) return edge
    }
    if (charClass(cell.char) !== kind) return edge
    edge = next
  }
}

export function wordBoundsAt(
  screen: Screen,
  col: number,
  row: number,
): { lo: number; hi: number } | null {
  return notBuilt('src/ink/geometry/word-line.ts:35')
}

export function selectWordAt(
  s: SelectionState,
  screen: Screen,
  col: number,
  row: number,
): void {
  return notBuilt('src/ink/geometry/word-line.ts:56')
}

export function selectLineAt(s: SelectionState, screen: Screen, row: number): void {
  return notBuilt('src/ink/geometry/word-line.ts:66')
}

export function extendSelection(
  s: SelectionState,
  screen: Screen,
  col: number,
  row: number,
): void {
  return notBuilt('src/ink/geometry/word-line.ts:71')
}
