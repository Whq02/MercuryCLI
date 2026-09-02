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
  charInCellAt,
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

// ============================================================================
//  FrameWriter — the Mercury frame differ/writer.
//
//  RESPONSIBILITY: prev Frame × next Frame × screen mode → the minimal Patch
//  list whose replay transforms the terminal from prev's painted state to
//  next's. The writer owns nothing else: composition owns the cells, the
//  serializer owns bytes, ink.tsx owns scheduling and cursor declarations.
//
//  CONTRACT (all mechanically pinned — scripts/core-runtime/
//  prove-writer-contract.ts + scripts/ink-runtime/prove-frame-replay.ts +
//  prove-inline-history.ts + the live visual baseline):
//    · REPLAY EQUALITY — text, styles and OSC 8 links, cell-exact;
//    · ZERO-DIRTY ⇒ ZERO PATCHES — an unchanged frame emits nothing;
//    · MAIN SCREEN (inline) — the bounded live region: never ED, rows ceded
//      to scrollback are frozen forever (print-once), coordinate-space breaks
//      start a NEW EPOCH (EL-clear own rows + repaint the ≤viewport tail);
//    · CURSOR LAW — after each frame the physical cursor sits exactly at the
//      frame's cursor position (the relative-move model's anchor);
//    · ALT SCREEN — full addressability, CUP allowed, DECSTBM scroll hints
//      honored when the sync-output capability makes them atomic;
//    · VOCABULARY-CLOSED — every patch serializes to escapes the replay
//      oracle understands; new vocabulary is a conscious oracle change.
//
//  MODES are explicit strategies, not interleaved conditionals:
//    · AltStrategy — the alternate screen (no scrollback to protect);
//    · InlineStrategy — the main screen (the operator's history is sacred).
// ============================================================================

type Options = {
  isTTY: boolean
  stylePool: StylePool
}

const CARRIAGE_RETURN = { type: 'carriageReturn' } as const
const NEWLINE = { type: 'stdout', content: '\n' } as const

// ── the cursor model ────────────────────────────────────────────────────────
// One owner for the physical-cursor estimate. Column moves are ABSOLUTE (CHA)
// — the model's column can lag the real terminal on East-Asian-Ambiguous
// glyphs (width-1 here, width-2 on ambiguous=wide terminals), and absolute
// anchoring stops the error from propagating. Row moves are RELATIVE on the
// main screen (CUP cannot address scrollback rows) and ABSOLUTE (CUP) on the
// alt screen (relative moves clamp at stale DECSTBM margins).
class CursorModel {
  x: number
  y: number

  constructor(
    origin: { x: number; y: number },
    private readonly viewportWidth: number,
    private readonly alt: boolean,
  ) {
    this.x = origin.x
    this.y = origin.y
  }

  /** True when the last write filled the final column — the terminal sits in
   *  its pending-wrap state and a CR is needed before any column math. */
  private pendingWrap(): boolean {
    return this.x >= this.viewportWidth
  }

  /** Position for a CELL WRITE. Same-row moves always emit an absolute CHA —
   *  East-Asian-Ambiguous glyphs (width 1 in our tables, 2 on ambiguous=wide
   *  terminals) let the real cursor lead the model; re-anchoring every write
   *  stops the error from propagating down the row. */
  anchorTo(out: Diff, targetX: number, targetY: number): void {
    const dy = targetY - this.y
    if (dy !== 0 || this.pendingWrap()) {
      this.rowMove(out, targetX, targetY, dy)
      return
    }
    out.push({ type: 'cursorTo', col: targetX + 1 })
    this.x = targetX
  }

  /** Position for a PARK (no write follows). Emits nothing when already
   *  there — the zero-dirty ⇒ zero-patches law rides on this. */
  moveTo(out: Diff, targetX: number, targetY: number): void {
    const dy = targetY - this.y
    if (dy !== 0 || this.pendingWrap()) {
      this.rowMove(out, targetX, targetY, dy)
      return
    }
    if (targetX !== this.x) {
      out.push({ type: 'cursorTo', col: targetX + 1 })
      this.x = targetX
    }
  }

  private rowMove(out: Diff, targetX: number, targetY: number, dy: number): void {
    if (this.alt) {
      // Absolute CUP: immune to stale scroll-region clamps.
      out.push({ type: 'styleStr', str: cursorPosition(targetY + 1, targetX + 1) })
    } else {
      out.push(CARRIAGE_RETURN)
      out.push({ type: 'cursorMove', x: targetX, y: dy })
    }
    this.x = targetX
    this.y = targetY
  }

  /** Advance to row `y` column 0 by emitting real line feeds — the only move
   *  that can CREATE rows (scrolling the viewport); CUD clamps at the bottom
   *  margin and cannot. */
  lineFeedTo(out: Diff, y: number): void {
    if (this.y >= y) return
    const n = y - this.y
    out.push(CARRIAGE_RETURN)
    for (let i = 0; i < n; i++) out.push(NEWLINE)
    this.x = 0
    this.y = y
  }

  wrote(cellWidth: number): void {
    if (this.x >= this.viewportWidth) {
      // Wrote through pending-wrap: the terminal wrapped to the next row.
      this.x = cellWidth
      this.y++
    } else {
      this.x += cellWidth
    }
  }
}

// ── the attribute cursor ────────────────────────────────────────────────────
// One owner for the terminal's SGR + OSC 8 state as the writer knows it.
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

// ── cell emission ───────────────────────────────────────────────────────────
/** Emoji classes whose width the host terminal's wcwidth tables may disagree
 *  about (Unicode 12+ blocks; text-default emoji forced wide by VS16). The
 *  compensation writes are no-ops on terminals with correct tables. */
function widthMayDisagree(char: string): boolean {
  const cp = char.codePointAt(0)
  if (cp === undefined) return false
  if ((cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x1fb00 && cp <= 0x1fbff)) return true
  if (char.length >= 2) {
    for (let i = 0; i < char.length; i++) {
      if (char.charCodeAt(i) === 0xfe0f) return true
    }
  }
  return false
}

/** Write one cell at the cursor. Returns false when the cell cannot be
 *  written (a wide glyph would cross the viewport edge) — attribute state is
 *  untouched in that case, so callers need no rollback. */
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
    // A wide glyph is refused ONLY when its two cells would CROSS the
    // viewport edge. An exact fit at the final two columns paints — multi-
    // codepoint graphemes (flags, ZWJ families) included: the old stricter
    // threshold for char.length > 2 silently dropped a legal exact fit
    //
    return false
  }

  attrs.toLink(out, cell.hyperlink)
  attrs.toStyle(out, cell.styleId)

  // Compensation needs column px+2 to EXIST (the pre-fill and the post-write
  // re-anchor both address it) — at an exact right-edge fit it is skipped:
  // an old-wcwidth terminal may leave the final column stale there, which
  // beats clamping the re-anchor (a cursor-model desync) or dropping the
  // glyph.
  const compensate =
    cellWidth === 2 && px + 2 < viewportWidth && widthMayDisagree(cell.char)
  if (compensate) {
    // Old-wcwidth terminals advance only 1 column for this glyph, leaving
    // column px+1 unpainted — pre-fill it, then let the glyph overwrite.
    out.push({ type: 'cursorTo', col: px + 2 })
    out.push({ type: 'stdout', content: ' ' })
    out.push({ type: 'cursorTo', col: px + 1 })
  }
  out.push({ type: 'stdout', content: cell.char })
  if (compensate) {
    out.push({ type: 'cursorTo', col: px + cellWidth + 1 })
  }
  cursor.wrote(cellWidth)
  return true
}

/** Paint rows [startY, endY) of `frame` in full. MAIN screen: one
 *  LF-advanced row at a time (LF is the only move that can CREATE rows —
 *  CUD clamps at the bottom margin); ends at column 0 of row endY with
 *  attributes reset. ALT screen: rows already exist and are addressable, so
 *  every advance is an absolute CUP and no trailing LF is ever emitted — a
 *  CR+NL after painting the BOTTOM row scrolls the whole buffer one row
 *  while the model stays put, and every later diff then repaints rows one
 *  off their painted position (the ghost-row / doubled-row class; pinned by
 *  prove-alt-paint-scroll). */
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
  let index = startY * width
  let lastStyleOnLine = -1
  for (let y = startY; y < endY; y++) {
    if (alt) cursor.moveTo(out, 0, y)
    else cursor.lineFeedTo(out, y)
    lastStyleOnLine = -1
    for (let x = 0; x < width; x++, index++) {
      // Skips spacers, unwritten cells, and fg-only spaces matching the last
      // rendered style — the pool-level visibility rule.
      const cell = visibleCellAtIndex(cells, charPool, hyperlinkPool, index, lastStyleOnLine)
      if (!cell) continue
      cursor.anchorTo(out, x, y)
      if (emitCell(out, cursor, attrs, cell, frame.viewport.width)) {
        lastStyleOnLine = cell.styleId
      }
    }
    // Attributes reset at the row boundary so background colors can't bleed
    // into scrolled-in rows (BCE) and styles never leak across rows.
    attrs.resetAll(out)
    if (!alt) {
      out.push(CARRIAGE_RETURN)
      out.push(NEWLINE)
      cursor.x = 0
      cursor.y = y + 1
    }
  }
}

/** The text of a model row (debug attribution for alt full-repaints). */
function readLine(screen: Screen, y: number): string {
  let line = ''
  for (let x = 0; x < screen.width; x++) {
    line += charInCellAt(screen, x, y) ?? ' '
  }
  return line.trimEnd()
}

// ── the ghost-pixel wipe ────────────────────────────────────────────────────
//  Some terminals draw the half-block glyphs a pixel or two past their cell:
//  a ▀ bleeds into the row ABOVE, a ▄ into the row BELOW, a full block into
//  both. The bleed is invisible while the glyph stands — the neighbour cell
//  is repainted whenever IT changes, and the glyph's own cell is opaque. It
//  becomes a sliver the moment the glyph LEAVES its cell while the neighbour
//  does not change: the diff rewrites the vacated cell alone, and the thin
//  line the old glyph left in the neighbour survives in a row nothing
//  rewrites (a critter's shape changing under an air row, a crown settling,
//  a shorter silhouette). The wipe re-emits exactly those neighbours — the
//  cell above a departed ▀, the cell below a departed ▄, both for a departed
//  █ — as their CURRENT value (one plain space when empty), so the terminal
//  repaints them and the sliver dies. A frame in which no half-block glyph
//  leaves a cell emits nothing extra: byte-identical to the plain diff.

/** The cell above / below / both, by the glyph that left. */
function bleedRows(char: string): 0 | 1 | 2 | 3 {
  if (char === '▀') return 1 // above
  if (char === '▄') return 2 // below
  if (char === '█') return 3 // both
  return 0
}

function cellsEqualAt(prev: Screen, next: Screen, x: number, y: number): boolean {
  if (x >= prev.width || x >= next.width || y >= prev.height || y >= next.height) return false
  const pci = (y * prev.width + x) << 1
  const nci = (y * next.width + x) << 1
  return prev.cells[pci] === next.cells[nci] && prev.cells[pci + 1] === next.cells[nci + 1]
}

/** The wipe's ledger — the neighbours a departing half-block glyph bled into
 *  (packed y·width+x), filled by one diff pass and cleared by the next: one
 *  reused Set, no per-frame allocation. */
const bleedLedger = new Set<number>()

// ── the shared dirty-cell diff pass ─────────────────────────────────────────
/** Walk prev→next cell diffs over rows [minRow, rowLimit) and emit minimal
 *  updates. Returns the row of the first diff BELOW minRow on the alt screen
 *  (unreachable rows ⇒ the caller full-repaints), or -1. */
function emitDirtyCells(
  out: Diff,
  cursor: CursorModel,
  attrs: AttributeCursor,
  prev: Frame,
  next: Frame,
  minRow: number,
  rowLimit: number,
  alt: boolean,
): { unreachableRow: number; droppedFrozen: number } {
  let unreachableRow = -1
  let droppedFrozen = 0
  bleedLedger.clear()
  const stride = next.screen.width
  diffEach(prev.screen, next.screen, (x, y, removed, added) => {
    if (y >= rowLimit) return // new rows — painted by the growth pass
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
    // A blank cell replacing nothing visible needs no write (and writing the
    // trailing spaces would risk viewport-edge wraps).
    if (added && isEmptyCellAt(next.screen, x, y) && !removed) return

    if (y < minRow) {
      if (!alt) {
        // Print-once: the row was ceded to scrollback — history keeps what
        // was true when it scrolled away.
        droppedFrozen++
        return
      }
      unreachableRow = y
      return true // stop the walk; the caller repaints
    }

    // The wipe's ledger: a half-block glyph leaving this cell names the
    // neighbour it bled into (the neighbour's own change, if any, is emitted
    // by this same walk; an unchanged neighbour is re-emitted below).
    if (removed && (!added || added.char !== removed.char)) {
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
      // Content removed with nothing in its place — paint one plain space.
      attrs.resetAll(out)
      out.push({ type: 'stdout', content: ' ' })
      cursor.wrote(1)
    }
  })
  if (bleedLedger.size > 0 && unreachableRow < 0) {
    for (const packed of bleedLedger) {
      const y = Math.floor(packed / stride)
      const x = packed - y * stride
      // A neighbour that changed this frame was written by the walk above.
      if (!cellsEqualAt(prev.screen, next.screen, x, y)) continue
      const cell = cellAt(next.screen, x, y)
      if (cell === undefined) continue
      if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) continue
      cursor.anchorTo(out, x, y)
      if (isEmptyCellAt(next.screen, x, y)) {
        attrs.resetAll(out)
        out.push({ type: 'stdout', content: ' ' })
        cursor.wrote(1)
      } else {
        emitCell(out, cursor, attrs, cell, next.viewport.width)
      }
    }
  }
  return { unreachableRow, droppedFrozen }
}

// ── the writer ──────────────────────────────────────────────────────────────
export class FrameWriter {
  /** Inline mode: content rows [0, flushedRows) are ceded to terminal
   *  scrollback — printed once, frozen forever. Monotonic within an epoch. */
  private flushedRows = 0

  constructor(private readonly options: Options) {}

  /** SIGCONT / session-restore seam: the writer keeps no byte-level cache to
   *  forget — the caller re-composes and the next render diffs from the frame
   *  pair it is given. The flush boundary survives deliberately: ceded rows
   *  stay ceded across a suspend (the terminal kept them in scrollback). */
  reset(): void {}

  /** The done/teardown path: restore cursor visibility if the last frame hid
   *  it. (The historical name was renderPreviousOutput_DEPRECATED.) */
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

  // ── alt screen ────────────────────────────────────────────────────────────
  private renderAlt(prev: Frame, next: Frame, decstbmSafe: boolean): Diff {
    const pool = this.options.stylePool

    // A resize breaks every row's meaning — repaint from scratch. Contained:
    // [2J on the alternate buffer touches no scrollback.
    if (
      next.viewport.height < prev.viewport.height ||
      (prev.viewport.width !== 0 && next.viewport.width !== prev.viewport.width)
    ) {
      return this.altFullRepaint(next, 'resize')
    }

    const out: Diff = []

    // DECSTBM scroll hint: shift the region with a hardware scroll and let
    // the diff pass repaint only the rows that scrolled IN. prev.screen is
    // about to become the back buffer — mutating it to simulate the shift is
    // the established safe pattern. Only when the BSU/ESU capability makes
    // the region-scroll + repaint atomic (decstbmSafe); otherwise the plain
    // diff writes all shifted rows — more bytes, no intermediate state.
    if (next.scrollHint && decstbmSafe) {
      const { top, bottom, delta } = next.scrollHint
      if (top >= 0 && bottom < prev.screen.height && bottom < next.screen.height) {
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

    // The cursor model starts at prev's cursor like the main screen — alt
    // row moves are absolute CUP, so the origin only matters for the
    // pending-wrap column check.
    const cursor = new CursorModel(prev.cursor, next.viewport.width, true)
    const attrs = new AttributeCursor(pool)

    // Content the previous frame pushed above the viewport is unreachable on
    // the alternate screen (no scrollback to cursor into) — a diff there
    // forces the contained full repaint.
    const minRow = frozenRowBoundary(prev, next)

    // Alt content is viewport-clamped in production; a shrink is repainted
    // rather than patched (per-line erases from an absolute cursor are the
    // main screen's tool — the alt buffer's [2J is contained and exact).
    if (Math.max(next.screen.height, 1) < Math.max(prev.screen.height, 1)) {
      const linesToClear = Math.max(prev.screen.height, 1) - Math.max(next.screen.height, 1)
      if (linesToClear > prev.viewport.height) {
        return this.altFullRepaint(next, 'offscreen')
      }
      attrs.resetAll(out)
      out.push({ type: 'clear', count: linesToClear })
      out.push({ type: 'cursorMove', x: 0, y: -1 })
      cursor.x = 0
      cursor.y = prev.cursor.y - linesToClear
    }

    const growthLimit = Math.min(prev.screen.height, next.screen.height)
    const { unreachableRow } = emitDirtyCells(out, cursor, attrs, prev, next, minRow, growthLimit, true)
    if (unreachableRow >= 0) {
      return this.altFullRepaint(next, 'offscreen', {
        triggerY: unreachableRow,
        prevLine: readLine(prev.screen, unreachableRow),
        nextLine: readLine(next.screen, unreachableRow),
      })
    }

    if (next.screen.height > prev.screen.height) {
      attrs.resetAll(out)
      paintRows(out, cursor, attrs, next, prev.screen.height, next.screen.height, true)
    }
    attrs.resetAll(out)
    // No cursor park: the next frame's CSI H preamble re-anchors regardless,
    // and ink.tsx parks the visible cursor itself.
    return out
  }

  private altFullRepaint(
    next: Frame,
    reason: FlickerReason,
    debug?: { triggerY: number; prevLine: string; nextLine: string },
  ): Diff {
    const out: Diff = [{ type: 'clearTerminal', reason, debug }]
    // Absolute-CUP cursor model: the repaint must never row-advance with an
    // LF (the bottom-row scroll) and absolute moves are immune to stale
    // DECSTBM margins.
    const cursor = new CursorModel({ x: 0, y: 0 }, next.viewport.width, true)
    const attrs = new AttributeCursor(this.options.stylePool)
    paintRows(out, cursor, attrs, next, 0, next.screen.height, true)
    attrs.resetAll(out)
    return out
  }

  /** Resize-storm holding paint (alt screen only): the frame's cells
   *  re-emitted CLIPPED to a viewport the layout has not caught up with. No
   *  clearTerminal — per-row EL sweeps residue the terminal's own clip or
   *  rewrap left, ED(0) covers rows below the clip. Bytes only: the frame
   *  MODEL is deliberately untouched, because the settled repaint that ends
   *  every storm rebuilds both frames from scratch and resyncs it. */
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
    // The hide this diff opened with is paired with a show when the frame
    // model's cursor is visible (FN-015 rank 74): under the accessibility
    // experience the hardware cursor is deliberately left visible for
    // screen readers and IME preedit, and the holding paint's bare hide
    // made the caret vanish at the first resize for the rest of the session
    // — no other writer restored it (finish() runs only on teardown).
    if (frame.cursor.visible) out.push({ type: 'cursorShow' })
    return out
  }

  // ── main screen (inline — the bounded live region) ───────────────────────
  private renderInline(prev: Frame, next: Frame): Diff {
    // EPOCH CLASSIFICATION — next's coordinate space must EXTEND prev's for
    // a diff to be meaningful. Three breaks, one response (a new epoch):
    //   · viewport shrank (the cursor's anchor row drifts),
    //   · width changed (the terminal re-wraps its own scrollback),
    //   · content collapsed below the flush line (row indices now alias
    //     frozen history).
    const widthBroke = prev.viewport.width !== 0 && next.viewport.width !== prev.viewport.width
    const viewportBroke = next.viewport.height < prev.viewport.height || widthBroke
    const shrankBelowFlush =
      next.screen.height < prev.screen.height && next.screen.height < this.flushedRows
    if (viewportBroke || shrankBelowFlush) {
      logForDebugging(
        `[inline epoch] ${viewportBroke ? 'viewport/width break' : 'shrink below flush'}: prevH=${prev.screen.height} nextH=${next.screen.height} flushed=${this.flushedRows}${widthBroke ? ' (width change: zone ceded, no erase)' : ''}`,
      )
      // A WIDTH change voids every model-space row count (FN-016 R10): the
      // terminal re-wraps its main-screen buffer under us — ConPTY/Windows
      // Terminal re-flows on every drag — so a model row wider than the
      // new column count occupies MORE physical rows (the erase stops
      // short: the old tail stays above the repaint) and re-joined soft
      // rows occupy FEWER (the erase walks up past the zone top and blanks
      // the operator's own shell scrollback). Neither count is knowable
      // from here, so a width break erases NOTHING beyond the writer's own
      // park row: the previous zone is ceded whole as frozen history and
      // the new frame paints fresh below it — the growth-frame shape,
      // print-once duplication as the documented epoch cost, the
      // operator's scrollback untouched. Height-only breaks keep the
      // erase: with the width unchanged no terminal re-wraps, and the
      // model arithmetic holds.
      return this.inlineEpochRepaint(prev, next, !widthBroke)
    }

    const out: Diff = []
    const cursor = new CursorModel(prev.cursor, next.viewport.width, false)
    const attrs = new AttributeCursor(this.options.stylePool)

    // Shrink: erase the vanished bottom rows in place (per-line EL — never
    // ED). The physical cursor parks ONE PAST the last content row, so the
    // erase must span the park row PLUS every vanished content row down to
    // (and including) row nextH — the boundary row a park-relative count of
    // prevH−nextH always missed (audit F1: the old body swept it cell-by-cell
    // through the diff; the count itself was one short). Raw heights: a
    // shrink to 0 rows must clear EVERYTHING. The erase ends at (0, nextH) —
    // exactly the next park target, so the park below stays a no-op. A
    // shrink taller than the viewport cannot be erased line-by-line —
    // defensive epoch (the flush-line guard normally catches it first).
    if (next.screen.height < prev.screen.height) {
      const count = prev.cursor.y - next.screen.height + 1
      if (count > prev.viewport.height) {
        logForDebugging('[inline epoch] over-viewport shrink fallback')
        return this.inlineEpochRepaint(prev, next)
      }
      if (count > 0) {
        out.push({ type: 'clear', count })
        cursor.x = 0
        cursor.y = next.screen.height
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
      // Growth LFs scrolled the live zone's top into scrollback — those rows
      // are now ceded. Monotonic; this frame's diff correctly used the OLD
      // boundary (the rows stayed reachable until the LFs above).
      const over = next.screen.height - this.flushedRows - next.viewport.height
      if (over > 0) this.flushedRows += over
    }

    attrs.resetAll(out)
    this.parkCursor(out, cursor, next)
    return out
  }

  /** NEW EPOCH: freeze everything above the live zone as history, EL-clear
   *  only the writer's own rows (never ED), repaint next's ≤viewport tail.
   *  The cost is print-once duplication; the operator's scrollback survives.
   *  `eraseLiveZone` false (a WIDTH break — R10): the erase extent is a
   *  model-space row count and the terminal just re-wrapped its buffer, so
   *  no count is honest — erase only the park row the cursor sits on (the
   *  writer's own, wherever re-flow put it) and cede the rest. */
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

    // The zone is cleared and the cursor sits at its top — which is content
    // row newFlushed in next's coordinate space.
    const cursor = new CursorModel({ x: 0, y: newFlushed }, next.viewport.width, false)
    const attrs = new AttributeCursor(pool)
    paintRows(out, cursor, attrs, next, newFlushed, nextH, false)
    attrs.resetAll(out)
    this.parkCursor(out, cursor, next)
    this.flushedRows = newFlushed
    return out
  }

  /** Main-screen cursor park: the frame's cursor row is usually one past the
   *  last content row — LFs create it (moves can't make rows). The
   *  row-creating park ends at column 0 (the next frame's moves are
   *  CR-anchored); a same-space park honors the column. Parking emits
   *  NOTHING when the cursor is already in place — the zero-dirty law. */
  private parkCursor(out: Diff, cursor: CursorModel, next: Frame): void {
    if (next.cursor.y >= next.screen.height && next.cursor.y > cursor.y) {
      cursor.lineFeedTo(out, next.cursor.y)
      return
    }
    cursor.moveTo(out, next.cursor.x, next.cursor.y)
  }

  // ── non-TTY: the whole frame as one styled string (pipes/tests) ──────────
  private renderFullFrameString(frame: Frame): Diff {
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
    if (lines.length === 0) return []
    return [{ type: 'stdout', content: lines.join('\n') }]
  }
}

/** Rows the previous frame pushed beyond cursor reach: content above the
 *  viewport, plus one when the previous frame's cursor park scrolled an extra
 *  row out (the park LF at a full viewport). One formula, both screens. */
function frozenRowBoundary(prev: Frame, next: Frame): number {
  const cursorAtBottom = prev.cursor.y >= prev.screen.height
  const parkScrolled = cursorAtBottom && prev.screen.height >= prev.viewport.height ? 1 : 0
  const growing = next.screen.height > prev.screen.height
  return growing
    ? Math.max(0, prev.screen.height - prev.viewport.height + parkScrolled)
    : Math.max(prev.screen.height, next.screen.height) - next.viewport.height + parkScrolled
}
