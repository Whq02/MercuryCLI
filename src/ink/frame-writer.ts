import { logForDebugging } from '../utils/debug.js'
import type { Diff, FlickerReason, Frame } from './frame.js'
import {
  type Cell,
  CellWidth,
  cellAt,
  diffEach,
  type Hyperlink,
  isEmptyCellAt,
  type Screen,
  type StylePool,
  shiftRows,
  visibleCellAtIndex,
} from './cell-grid.js'
import {
  CURSOR_HOME,
  cursorPosition,
  eraseToEndOfLine,
  eraseToEndOfScreen,
  RESET_SCROLL_REGION,
  scrollDown as csiScrollDown,
  scrollUp as csiScrollUp,
  setScrollRegion,
} from './termio/csi.js'
import { LINK_END, link as oscLink } from './termio/osc.js'
import { widthMayDisagree as measuredWidthMayDisagree } from './width-probe-table.js'
import { readTerminalWidthMeasurements } from './session/widthProbe.js'


type Options = {
  isTTY: boolean
  stylePool: StylePool
}

const CARRIAGE_RETURN = { type: 'carriageReturn' } as const
const NEWLINE = { type: 'stdout', content: '\n' } as const
const BRIDGED_GAP = 4

let openRun: { type: 'stdout'; content: string } | null = null

function appendText(out: Diff, text: string): void {
  const run = openRun
  if (run !== null && out[out.length - 1] === run) {
    run.content += text
    return
  }
  openRun = { type: 'stdout', content: text }
  out.push(openRun)
}

class CursorModel {
  x: number
  y: number
  private exact = false

  constructor(
    origin: { x: number; y: number },
    private readonly viewportWidth: number,
    private readonly alt: boolean,
  ) {
    this.x = origin.x
    this.y = origin.y
  }

  private pendingWrap(): boolean {
    return this.x >= this.viewportWidth
  }

  anchorTo(out: Diff, targetX: number, targetY: number): void {
    const dy = targetY - this.y
    if (dy !== 0 || this.pendingWrap()) {
      this.rowMove(out, targetX, targetY, dy)
      return
    }
    if (this.exact && targetX === this.x) return
    out.push({ type: 'cursorTo', col: targetX + 1 })
    this.x = targetX
    this.exact = true
  }

  moveTo(out: Diff, targetX: number, targetY: number): void {
    const dy = targetY - this.y
    if (dy !== 0 || this.pendingWrap()) {
      this.rowMove(out, targetX, targetY, dy)
      return
    }
    if (targetX !== this.x) {
      out.push({ type: 'cursorTo', col: targetX + 1 })
      this.x = targetX
      this.exact = true
    }
  }

  private rowMove(out: Diff, targetX: number, targetY: number, dy: number): void {
    if (this.alt) {
      out.push({ type: 'styleStr', str: cursorPosition(targetY + 1, targetX + 1) })
    } else {
      out.push(CARRIAGE_RETURN)
      out.push({ type: 'cursorMove', x: targetX, y: dy })
    }
    this.place(targetX, targetY)
  }

  lineFeedTo(out: Diff, y: number): void {
    if (this.y >= y) return
    const n = y - this.y
    out.push(CARRIAGE_RETURN)
    for (let i = 0; i < n; i++) out.push(NEWLINE)
    this.place(0, y)
  }

  place(x: number, y: number): void {
    this.x = x
    this.y = y
    this.exact = true
  }

  sitsAt(x: number, y: number): boolean {
    return this.exact && this.x === x && this.y === y && !this.pendingWrap()
  }

  wrote(cellWidth: number, agreed: boolean): void {
    if (this.x >= this.viewportWidth) {
      this.x = cellWidth
      this.y++
      this.exact = false
    } else {
      this.x += cellWidth
      this.exact = agreed
    }
  }
}

function agreedAdvance(char: string): boolean {
  if (char.length !== 1) return false
  const code = char.charCodeAt(0)
  return (code >= 0x20 && code <= 0x7e) || (code >= 0x2500 && code <= 0x257f)
}

class AttributeCursor {
  private styleId: number
  private hyperlink: Hyperlink = undefined

  constructor(private readonly pool: StylePool) {
    this.styleId = pool.none
  }

  toStyle(out: Diff, targetId: number): void {
    if (targetId === this.styleId) return
    const str = this.pool.transition(this.styleId, targetId)
    if (str.length > 0) out.push({ type: 'styleStr', str })
    this.styleId = targetId
  }

  toLink(out: Diff, target: Hyperlink): void {
    if (target === this.hyperlink) return
    out.push({ type: 'hyperlink', uri: target ?? '' })
    this.hyperlink = target
  }

  resetAll(out: Diff): void {
    this.toStyle(out, this.pool.none)
    this.toLink(out, undefined)
  }
}

function widthMayDisagree(char: string): boolean {
  return measuredWidthMayDisagree(char, readTerminalWidthMeasurements())
}

function emitCell(
  out: Diff,
  cursor: CursorModel,
  attrs: AttributeCursor,
  cell: Cell,
  viewportWidth: number,
): boolean {
  const cellWidth = cell.width === CellWidth.Wide ? 2 : 1
  const px = cursor.x
  if (cellWidth === 2 && px < viewportWidth && px + 2 > viewportWidth) {
    return false
  }

  attrs.toLink(out, cell.hyperlink)
  attrs.toStyle(out, cell.styleId)

  const compensate =
    cellWidth === 2 && px + 2 < viewportWidth && widthMayDisagree(cell.char)
  if (compensate) {
    out.push({ type: 'cursorTo', col: px + 2 })
    out.push({ type: 'stdout', content: ' ' })
    out.push({ type: 'cursorTo', col: px + 1 })
  }
  appendText(out, cell.char)
  if (compensate) {
    out.push({ type: 'cursorTo', col: px + cellWidth + 1 })
  }
  cursor.wrote(cellWidth, compensate || agreedAdvance(cell.char))
  return true
}

function paintRows(
  out: Diff,
  cursor: CursorModel,
  attrs: AttributeCursor,
  frame: Frame,
  startY: number,
  endY: number,
  alt: boolean,
): void {
  const { width, cells, charPool, hyperlinkPool } = frame.screen
  const rowEnd = alt ? Math.min(endY, frame.viewport.height) : endY
  const columnEnd = alt ? Math.min(width, frame.viewport.width) : width
  let lastStyleOnLine = -1
  for (let y = startY; y < rowEnd; y++) {
    if (alt) cursor.moveTo(out, 0, y)
    else cursor.lineFeedTo(out, y)
    lastStyleOnLine = -1
    let gapStart = -1
    let index = y * width
    for (let x = 0; x < columnEnd; x++, index++) {
      const cell = visibleCellAtIndex(cells, charPool, hyperlinkPool, index, lastStyleOnLine)
      if (!cell) {
        if (gapStart < 0 && cursor.sitsAt(x, y)) gapStart = x
        continue
      }
      if (gapStart >= 0) {
        const gap = x - gapStart
        if (gap <= BRIDGED_GAP && (lastStyleOnLine === -1 || (lastStyleOnLine & 1) === 0) && cursor.sitsAt(gapStart, y)) {
          appendText(out, ' '.repeat(gap))
          cursor.wrote(gap, true)
        }
        gapStart = -1
      }
      cursor.anchorTo(out, x, y)
      if (emitCell(out, cursor, attrs, cell, frame.viewport.width)) {
        lastStyleOnLine = cell.styleId
      }
    }
    attrs.resetAll(out)
    if (!alt) {
      out.push(CARRIAGE_RETURN)
      out.push(NEWLINE)
      cursor.place(0, y + 1)
    }
  }
}


function bleedRows(char: string): 0 | 1 | 2 | 3 {
  if (char === '▀') return 1
  if (char === '▄') return 2
  if (char === '█') return 3
  return 0
}

function cellsEqualAt(prev: Screen, next: Screen, x: number, y: number): boolean {
  if (x >= prev.width || x >= next.width || y >= prev.height || y >= next.height) return false
  const pci = (y * prev.width + x) << 1
  const nci = (y * next.width + x) << 1
  return prev.cells[pci] === next.cells[nci] && prev.cells[pci + 1] === next.cells[nci + 1]
}

const bleedLedger = new Set<number>()

function emitDirtyCells(
  out: Diff,
  cursor: CursorModel,
  attrs: AttributeCursor,
  prev: Frame,
  next: Frame,
  minRow: number,
  rowLimit: number,
  alt: boolean,
): { droppedFrozen: number } {
  let droppedFrozen = 0
  bleedLedger.clear()
  const stride = next.screen.width
  diffEach(prev.screen, next.screen, (x, y, removed, added) => {
    if (y >= rowLimit) return
    if (alt && x >= next.viewport.width) return
    if (
      added &&
      (added.width === CellWidth.SpacerTail || added.width === CellWidth.SpacerHead)
    ) {
      return
    }
    if (
      removed &&
      (removed.width === CellWidth.SpacerTail || removed.width === CellWidth.SpacerHead) &&
      !added
    ) {
      return
    }
    if (added && isEmptyCellAt(next.screen, x, y) && !removed) return

    if (y < minRow) {
      if (!alt) {
        droppedFrozen++
        return
      }
      return
    }

    if (removed && (!added || added.char !== removed.char || added.styleId !== removed.styleId)) {
      const rows = bleedRows(removed.char)
      if (rows !== 0) {
        if ((rows & 1) !== 0 && y > minRow) bleedLedger.add((y - 1) * stride + x)
        if ((rows & 2) !== 0 && y + 1 < rowLimit) bleedLedger.add((y + 1) * stride + x)
      }
    }

    cursor.anchorTo(out, x, y)
    if (added) {
      emitCell(out, cursor, attrs, added, next.viewport.width)
    } else if (removed) {
      attrs.resetAll(out)
      appendText(out, ' ')
      cursor.wrote(1, true)
    }
  })
  if (bleedLedger.size > 0) {
    for (const packed of bleedLedger) {
      const y = Math.floor(packed / stride)
      const x = packed - y * stride
      if (!cellsEqualAt(prev.screen, next.screen, x, y)) continue
      const cell = cellAt(next.screen, x, y)
      if (cell === undefined) continue
      if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) continue
      cursor.anchorTo(out, x, y)
      if (isEmptyCellAt(next.screen, x, y)) {
        attrs.resetAll(out)
        appendText(out, ' ')
        cursor.wrote(1, true)
      } else {
        emitCell(out, cursor, attrs, cell, next.viewport.width)
      }
    }
  }
  return { droppedFrozen }
}

export class FrameWriter {
  private flushedRows = 0

  constructor(private readonly options: Options) {}

  reset(): void {}

  finish(prev: Frame): Diff {
    if (!this.options.isTTY) return [NEWLINE]
    if (!prev.cursor.visible) return [{ type: 'cursorShow' }]
    return []
  }

  render(prev: Frame, next: Frame, altScreen = false, decstbmSafe = true): Diff {
    if (!this.options.isTTY) return this.renderFullFrameString(next)
    const started = performance.now()
    const diff = altScreen
      ? this.renderAlt(prev, next, decstbmSafe)
      : this.renderInline(prev, next)
    const elapsed = performance.now() - started
    if (elapsed > 50) {
      const damage = next.screen.damage
      logForDebugging(
        `Slow render: ${elapsed.toFixed(1)}ms, screen: ${next.screen.height}x${next.screen.width}, ` +
          `damage: ${damage ? `${damage.width}x${damage.height} at (${damage.x},${damage.y})` : 'none'}, ` +
          `patches: ${diff.length}`,
      )
    }
    return diff
  }

  private renderAlt(prev: Frame, next: Frame, decstbmSafe: boolean): Diff {
    const pool = this.options.stylePool

    if (
      next.viewport.height !== prev.viewport.height ||
      (prev.viewport.width !== 0 && next.viewport.width !== prev.viewport.width)
    ) {
      return this.altFullRepaint(next, 'resize')
    }

    const out: Diff = []

    if (next.scrollHint && decstbmSafe) {
      const { top, bottom, delta } = next.scrollHint
      if (top >= 0 && bottom < prev.screen.height && bottom < next.screen.height && bottom < next.viewport.height) {
        shiftRows(prev.screen, top, bottom, delta)
        out.push({
          type: 'stdout',
          content:
            setScrollRegion(top + 1, bottom + 1) +
            (delta > 0 ? csiScrollUp(delta) : csiScrollDown(-delta)) +
            RESET_SCROLL_REGION +
            CURSOR_HOME,
        })
      }
    }

    const cursor = new CursorModel(prev.cursor, next.viewport.width, true)
    const attrs = new AttributeCursor(pool)

    const prevHeight = Math.min(prev.screen.height, next.viewport.height)
    const nextHeight = Math.min(next.screen.height, next.viewport.height)

    if (nextHeight < prevHeight) return this.altFullRepaint(next, 'offscreen')

    const growthLimit = Math.min(prevHeight, nextHeight)
    emitDirtyCells(out, cursor, attrs, prev, next, 0, growthLimit, true)

    if (nextHeight > prevHeight) {
      attrs.resetAll(out)
      paintRows(out, cursor, attrs, next, prevHeight, nextHeight, true)
    }
    attrs.resetAll(out)
    return out
  }

  private altFullRepaint(
    next: Frame,
    reason: FlickerReason,
  ): Diff {
    const out: Diff = [{ type: 'clearTerminal', reason }]
    const cursor = new CursorModel({ x: 0, y: 0 }, next.viewport.width, true)
    const attrs = new AttributeCursor(this.options.stylePool)
    paintRows(out, cursor, attrs, next, 0, next.screen.height, true)
    attrs.resetAll(out)
    return out
  }

  holdingClipPaint(frame: Frame, cols: number, rows: number): Diff {
    const { width, height, cells, charPool, hyperlinkPool } = frame.screen
    if (width === 0 || height === 0 || cols <= 0 || rows <= 0) return []
    const out: Diff = [{ type: 'cursorHide' }]
    const clipH = Math.min(height, rows)
    const clipW = Math.min(width, cols)
    const cursor = new CursorModel({ x: 0, y: 0 }, cols, true)
    const attrs = new AttributeCursor(this.options.stylePool)
    for (let y = 0; y < clipH; y++) {
      cursor.moveTo(out, 0, y)
      let lastStyleOnLine = -1
      let index = y * width
      for (let x = 0; x < clipW; x++, index++) {
        const cell = visibleCellAtIndex(cells, charPool, hyperlinkPool, index, lastStyleOnLine)
        if (!cell) continue
        cursor.anchorTo(out, x, y)
        if (emitCell(out, cursor, attrs, cell, cols)) lastStyleOnLine = cell.styleId
      }
      attrs.resetAll(out)
      out.push({ type: 'stdout', content: eraseToEndOfLine() })
    }
    if (clipH < rows) {
      cursor.moveTo(out, 0, clipH)
      out.push({ type: 'stdout', content: eraseToEndOfScreen() })
    }
    if (frame.cursor.visible) out.push({ type: 'cursorShow' })
    return out
  }

  private renderInline(prev: Frame, next: Frame): Diff {
    const widthBroke = prev.viewport.width !== 0 && next.viewport.width !== prev.viewport.width
    const viewportBroke = next.viewport.height < prev.viewport.height || widthBroke
    const shrankBelowFlush =
      next.screen.height < prev.screen.height && next.screen.height < this.flushedRows
    if (viewportBroke || shrankBelowFlush) {
      logForDebugging(
        `[inline epoch] ${viewportBroke ? 'viewport/width break' : 'shrink below flush'}: prevH=${prev.screen.height} nextH=${next.screen.height} flushed=${this.flushedRows}${widthBroke ? ' (width change: zone ceded, no erase)' : ''}`,
      )
      return this.inlineEpochRepaint(prev, next, !widthBroke)
    }

    const out: Diff = []
    const cursor = new CursorModel(prev.cursor, next.viewport.width, false)
    const attrs = new AttributeCursor(this.options.stylePool)

    if (next.screen.height < prev.screen.height) {
      const count = prev.cursor.y - next.screen.height + 1
      if (count > prev.viewport.height) {
        logForDebugging('[inline epoch] over-viewport shrink fallback')
        return this.inlineEpochRepaint(prev, next)
      }
      if (count > 0) {
        out.push({ type: 'clear', count })
        cursor.place(0, next.screen.height)
      }
    }

    const frozenBoundary = Math.max(frozenRowBoundary(prev, next), this.flushedRows)
    const growing = next.screen.height > prev.screen.height
    const growthLimit = Math.min(prev.screen.height, next.screen.height)
    const { droppedFrozen } = emitDirtyCells(
      out,
      cursor,
      attrs,
      prev,
      next,
      frozenBoundary,
      growthLimit,
      false,
    )
    if (droppedFrozen > 0) {
      logForDebugging(
        `[inline] print-once: dropped ${droppedFrozen} frozen-row cell diff(s) below row ${frozenBoundary}`,
      )
    }

    if (growing) {
      attrs.resetAll(out)
      paintRows(out, cursor, attrs, next, prev.screen.height, next.screen.height, false)
      const over = next.screen.height - this.flushedRows - next.viewport.height
      if (over > 0) this.flushedRows += over
    }

    attrs.resetAll(out)
    this.parkCursor(out, cursor, next)
    return out
  }

  private inlineEpochRepaint(prev: Frame, next: Frame, eraseLiveZone = true): Diff {
    const pool = this.options.stylePool
    const viewportH = Math.max(1, next.viewport.height)
    const nextH = Math.max(next.screen.height, 1)
    const newFlushed = Math.max(0, nextH - viewportH)

    const out: Diff = []
    const prevLiveTop = Math.max(0, this.flushedRows)
    const clearCount = eraseLiveZone
      ? Math.max(
          1,
          Math.min(
            prev.cursor.y - prevLiveTop + 1,
            prev.viewport.height || viewportH,
            viewportH,
          ),
        )
      : 1
    out.push({ type: 'clear', count: clearCount })

    const cursor = new CursorModel({ x: 0, y: newFlushed }, next.viewport.width, false)
    const attrs = new AttributeCursor(pool)
    paintRows(out, cursor, attrs, next, newFlushed, nextH, false)
    attrs.resetAll(out)
    this.parkCursor(out, cursor, next)
    this.flushedRows = newFlushed
    return out
  }

  private parkCursor(out: Diff, cursor: CursorModel, next: Frame): void {
    if (next.cursor.y >= next.screen.height && next.cursor.y > cursor.y) {
      cursor.lineFeedTo(out, next.cursor.y)
      return
    }
    cursor.moveTo(out, next.cursor.x, next.cursor.y)
  }

  private renderFullFrameString(frame: Frame): Diff {
    if (frame.screen.height === 0) return []
    return [{ type: 'stdout', content: this.fullFrameText(frame) }]
  }

  fullFrameText(frame: Frame): string {
    const { screen } = frame
    const pool = this.options.stylePool
    const lines: string[] = []
    let styleId = pool.none
    let hyperlink: Hyperlink = undefined
    for (let y = 0; y < screen.height; y++) {
      let line = ''
      for (let x = 0; x < screen.width; x++) {
        const cell = cellAt(screen, x, y)
        if (cell && cell.width !== CellWidth.SpacerTail) {
          if (cell.hyperlink !== hyperlink) {
            if (hyperlink !== undefined) line += LINK_END
            if (cell.hyperlink !== undefined) line += oscLink(cell.hyperlink)
            hyperlink = cell.hyperlink
          }
          line += pool.transition(styleId, cell.styleId)
          styleId = cell.styleId
          line += cell.char
        }
      }
      if (hyperlink !== undefined) {
        line += LINK_END
        hyperlink = undefined
      }
      line += pool.transition(styleId, pool.none)
      styleId = pool.none
      lines.push(line.trimEnd())
    }
    return lines.join('\n')
  }
}

function frozenRowBoundary(prev: Frame, next: Frame): number {
  const cursorAtBottom = prev.cursor.y >= prev.screen.height
  const parkScrolled = cursorAtBottom && prev.screen.height >= prev.viewport.height ? 1 : 0
  const growing = next.screen.height > prev.screen.height
  return growing
    ? Math.max(0, prev.screen.height - prev.viewport.height + parkScrolled)
    : Math.max(prev.screen.height, next.screen.height) - next.viewport.height + parkScrolled
}
