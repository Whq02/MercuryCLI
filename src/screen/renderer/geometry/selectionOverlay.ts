import type { Screen, StylePool } from '../cell-grid.js'
import { cellAtIndex, CellWidth, setCellStyleId } from '../cell-grid.js'
import type { Rectangle } from '../layout/geometry.js'
import { selectionBounds, type SelectionState } from './selection-model.js'

export class OverlayRecord {
  private readonly cells: number[] = []

  constructor(readonly width: number) {}

  get size(): number {
    return this.cells.length / 3
  }

  restyle(screen: Screen, x: number, y: number, styleId: number): void {
    if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return
    const index = y * screen.width + x
    const cell = cellAtIndex(screen, index)
    if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) return
    if (cell.styleId === styleId) return
    setCellStyleId(screen, x, y, styleId)
    this.cells.push(index, cell.styleId, styleId)
  }

  revert(screen: Screen): void {
    if (screen.width !== this.width) return
    const c = this.cells
    for (let i = c.length - 3; i >= 0; i -= 3) {
      const index = c[i]!
      setCellStyleId(screen, index % this.width, Math.floor(index / this.width), c[i + 1]!)
    }
  }

  restore(screen: Screen): void {
    if (screen.width !== this.width) return
    const c = this.cells
    for (let i = 0; i < c.length; i += 3) {
      const index = c[i]!
      setCellStyleId(screen, index % this.width, Math.floor(index / this.width), c[i + 2]!)
    }
  }

  rect(): Rectangle | null {
    const c = this.cells
    if (c.length === 0) return null
    const w = this.width
    let x0 = c[0]! % w
    let x1 = x0
    let y0 = Math.floor(c[0]! / w)
    let y1 = y0
    for (let i = 3; i < c.length; i += 3) {
      const index = c[i]!
      const x = index % w
      const y = Math.floor(index / w)
      if (x < x0) x0 = x
      else if (x > x1) x1 = x
      if (y < y0) y0 = y
      else if (y > y1) y1 = y
    }
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
  }
}

export function restyleCell(
  screen: Screen,
  x: number,
  y: number,
  styleId: number,
  record?: OverlayRecord,
): void {
  if (record) record.restyle(screen, x, y, styleId)
  else setCellStyleId(screen, x, y, styleId)
}

export function applySelectionOverlay(
  screen: Screen,
  selection: SelectionState,
  stylePool: StylePool,
  record?: OverlayRecord,
): void {
  const bounds = selectionBounds(selection)
  if (!bounds) return
  const firstRow = Math.max(0, bounds.start.row, selection.clipTop ?? 0)
  const lastRow = Math.min(screen.height - 1, bounds.end.row, selection.clipBottom ?? screen.height - 1)
  const bandLo = Math.max(0, selection.clipLo ?? 0)
  const bandHi = Math.min(screen.width - 1, selection.clipHi ?? screen.width - 1)
  for (let row = firstRow; row <= lastRow; row++) {
    const colStart = Math.max(row === bounds.start.row ? bounds.start.col : 0, bandLo)
    const colEnd = Math.min(row === bounds.end.row ? bounds.end.col : screen.width - 1, bandHi)
    const rowStart = row * screen.width
    for (let col = colStart; col <= colEnd; col++) {
      const index = rowStart + col
      if (screen.noSelect[index] === 1) continue
      const cell = cellAtIndex(screen, index)
      if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) continue
      restyleCell(screen, col, row, stylePool.withSelectionBg(cell.styleId), record)
    }
  }
}
