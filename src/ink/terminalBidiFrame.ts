import { shapeBidiForTerminal } from './bidi.js'
import { cellAt, CellWidth, setCellAt, type Screen } from './cell-grid.js'
import type { Frame } from './frame.js'
import { terminalTextCells } from './session/terminalTextCells.js'

export function terminalBidiFrame(frame: Frame): Frame {
  if (!terminalTextCells().shapeRtl) return frame
  const source = frame.screen
  let projected: Screen | undefined
  for (let y = 0; y < source.height; y++) {
    const row = []
    for (let x = 0; x < source.width; x++) {
      const cell = cellAt(source, x, y)!
      if (cell.width === CellWidth.SpacerTail) continue
      row.push({
        value: cell.width === CellWidth.SpacerHead ? ' ' : cell.char,
        width: cell.width === CellWidth.Wide ? 2 : 1,
        styleId: cell.styleId,
        hyperlink: cell.hyperlink,
      })
    }
    const paint = shapeBidiForTerminal(row)
    if (paint === row) continue
    if (!projected) {
      const cells = source.cells.slice()
      projected = { ...source, cells, cells64: new BigInt64Array(cells.buffer) }
    }
    let x = 0
    for (const cell of paint) {
      setCellAt(projected, x, y, {
        char: cell.value,
        width: cell.width === 2 ? CellWidth.Wide : CellWidth.Narrow,
        styleId: cell.styleId,
        hyperlink: cell.hyperlink,
      })
      x += cell.width
    }
  }
  return projected ? { ...frame, screen: projected } : frame
}
