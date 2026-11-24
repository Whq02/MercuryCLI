import { containsRtl, shapeBidiForTerminal } from './bidi.js'
import { cellAt, CellWidth, setCellAt, type CharPool, type Screen } from './cell-grid.js'
import type { Frame } from './frame.js'
import { terminalTextCells } from './terminal-session/terminalTextCells.js'

type RtlGlyphs = { flags: boolean[]; any: boolean }

const rtlGlyphs = new WeakMap<CharPool, RtlGlyphs>()

function rtlGlyphsOf(pool: CharPool): RtlGlyphs {
  let known = rtlGlyphs.get(pool)
  if (!known) {
    known = { flags: [], any: false }
    rtlGlyphs.set(pool, known)
  }
  for (let id = known.flags.length; id < pool.size(); id++) {
    const rtl = containsRtl(pool.get(id))
    known.flags.push(rtl)
    if (rtl) known.any = true
  }
  return known
}

export function holdsRtl(screen: Screen): boolean {
  return rtlGlyphsOf(screen.charPool).any
}

export function rowHoldsRtl(screen: Screen, y: number): boolean {
  if (y >= screen.height) return false
  const glyphs = rtlGlyphsOf(screen.charPool).flags
  const end = (y + 1) * screen.width * 2
  for (let at = y * screen.width * 2; at < end; at += 2) {
    if (glyphs[screen.cells[at]!]) return true
  }
  return false
}

export function terminalBidiFrame(frame: Frame): Frame {
  if (!terminalTextCells().shapeRtl) return frame
  const source = frame.screen
  if (!holdsRtl(source)) return frame
  let projected: Screen | undefined
  for (let y = 0; y < source.height; y++) {
    if (!rowHoldsRtl(source, y)) continue
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
