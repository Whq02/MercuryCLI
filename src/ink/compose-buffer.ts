import {
  type AnsiCode,
  type StyledChar,
  styledCharsFromTokens,
  tokenize,
} from '@alcalzone/ansi-tokenize'
import { logForDebugging } from '../utils/debug.js'
import { getGraphemeSegmenter } from '../utils/intl.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { reorderBidi } from './bidi.js'
import { type Rectangle, unionRect } from './layout/geometry.js'
import {
  blitRegion,
  CellWidth,
  extractHyperlinkFromStyles,
  filterOutHyperlinkStyles,
  markNoSelectRegion,
  OSC8_PREFIX,
  resetScreen,
  type Screen,
  type StylePool,
  setCellAt,
  shiftRect,
  shiftRows,
} from './cell-grid.js'
import { stringWidth } from './stringWidth.js'
import { widestLine } from './widest-line.js'

// ============================================================================
//  compose-buffer — the Mercury composition buffer.
//
//  RESPONSIBILITY: collect the render walk's operations (write · blit ·
//  clear · shift · clip · noSelect) and apply them to the frame's Screen in
//  ONE deterministic pass. The buffer owns the clip stack, the text→cells
//  lane (ANSI tokenize → grapheme clusters → bidi → cells, with the per-line
//  cluster cache), and the op-application ORDER rules:
//    · clears are damage-only (the screen is freshly zeroed) and run first;
//    · clears from ABSOLUTE nodes additionally exclude overlapped rows from
//      later blits (an absolute node overlays non-siblings — a clean
//      sibling's blit would re-import the overlay's stale paint);
//    · noSelect marks run LAST so they win over blitted bitmaps.
//
//  CONTRACT: pinned by scripts/core-runtime/prove-compose-contract.ts (the
//  incremental ≡ fresh law rides the op semantics here), the frame goldens,
//  the layout corpus, and the live visual baseline.
// ============================================================================

/** A grapheme cluster with precomputed width/style/link — built once per
 *  unique line (the cluster cache), so the per-cell hot loop is property
 *  reads + setCellAt. styleIds are session-lived (StylePool never resets);
 *  hyperlinks stay strings (the link pool DOES reset generationally). */
type ClusteredChar = {
  value: string
  width: number
  styleId: number
  hyperlink: string | undefined
}

export type Clip = {
  x1: number | undefined
  x2: number | undefined
  y1: number | undefined
  y2: number | undefined
}

type WriteOp = {
  type: 'write'
  x: number
  y: number
  text: string
  /** Per-line soft-wrap continuation flags, parallel to text.split('\n'). */
  softWrap?: boolean[]
}
type ClipOp = { type: 'clip'; clip: Clip }
type UnclipOp = { type: 'unclip' }
type BlitOp = { type: 'blit'; src: Screen; x: number; y: number; width: number; height: number }
type ClearOp = { type: 'clear'; region: Rectangle; fromAbsolute?: boolean }
type NoSelectOp = { type: 'noSelect'; region: Rectangle }
type ShiftOp = { type: 'shift'; top: number; bottom: number; n: number }
type ShiftRectOp = {
  type: 'shift-rect'
  top: number
  bottom: number
  x0: number
  x1: number
  n: number
}

export type Operation =
  | WriteOp
  | ClipOp
  | UnclipOp
  | BlitOp
  | ClearOp
  | NoSelectOp
  | ShiftOp
  | ShiftRectOp

/** Tightest-constraint clip intersection; undefined = unbounded on that side. */
function intersectClip(parent: Clip | undefined, child: Clip): Clip {
  if (!parent) return child
  return {
    x1: maxDefined(parent.x1, child.x1),
    x2: minDefined(parent.x2, child.x2),
    y1: maxDefined(parent.y1, child.y1),
    y2: minDefined(parent.y2, child.y2),
  }
}
function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a > b ? a : b
}
function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a < b ? a : b
}

// Forensics: per-compose paint accounting (INK_COMPOSED_TEE reads this).
// Full-screen damage with small `write` = a screen-sized CLEAR; large `write`
// with small `blit` = the clean-subtree blit isn't engaging.
export const lastComposeCounts = { blit: 0, write: 0, clearArea: 0, ops: 0 }

type Options = {
  width: number
  height: number
  stylePool: StylePool
  /** The screen composed into — reset before use (double-buffering). */
  screen: Screen
}

export default class ComposeBuffer {
  width: number
  height: number
  private readonly stylePool: StylePool
  private screen: Screen
  private readonly operations: Operation[] = []
  private clusterCache: Map<string, ClusteredChar[]> = new Map()

  constructor(options: Options) {
    this.width = options.width
    this.height = options.height
    this.stylePool = options.stylePool
    this.screen = options.screen
    resetScreen(this.screen, this.width, this.height)
  }

  /** Reuse for a new frame: zero the screen, drop the ops (storage kept),
   *  cap the cluster cache. Keeping the cache across frames is the win —
   *  most lines don't change between renders. */
  reset(width: number, height: number, screen: Screen): void {
    this.width = width
    this.height = height
    this.screen = screen
    this.operations.length = 0
    resetScreen(screen, width, height)
    if (this.clusterCache.size > 16384) this.clusterCache.clear()
  }

  write(x: number, y: number, text: string, softWrap?: boolean[]): void {
    if (!text) return
    this.operations.push({ type: 'write', x, y, text, softWrap })
  }

  clip(clip: Clip): void {
    this.operations.push({ type: 'clip', clip })
  }

  unclip(): void {
    this.operations.push({ type: 'unclip' })
  }

  blit(src: Screen, x: number, y: number, width: number, height: number): void {
    this.operations.push({ type: 'blit', src, x, y, width, height })
  }

  /** Full-width row shift mirroring DECSTBM + SU/SD (the scroll fast path). */
  shift(top: number, bottom: number, n: number): void {
    this.operations.push({ type: 'shift', top, bottom, n })
  }

  /** Column-bounded shift for panes narrower than the output. Unlike
   *  shift(), applying it UNIONS the pane rect into damage — no terminal
   *  scroll-region ever moves these rows, so the diff must re-emit them. */
  shiftRect(top: number, bottom: number, x0: number, x1: number, n: number): void {
    this.operations.push({ type: 'shift-rect', top, bottom, x0, x1, n })
  }

  /** Damage-only clear (the buffer is freshly zeroed). fromAbsolute marks
   *  the vacated bounds of an absolute overlay — later blits exclude those
   *  rows (see the pass-1 rule in the header). */
  clear(region: Rectangle, fromAbsolute?: boolean): void {
    this.operations.push({ type: 'clear', region, fromAbsolute })
  }

  /** Fence a region from text selection. Applied LAST — wins over blits. */
  noSelect(region: Rectangle): void {
    this.operations.push({ type: 'noSelect', region })
  }

  /** Apply every collected operation to the screen, in order, and return it. */
  get(): Screen {
    const screen = this.screen
    const W = this.width
    const H = this.height
    let blitCells = 0
    let writeCells = 0
    let clearArea = 0

    // Pass 1 — clears: expand damage (the buffer is zeroed; the diff must
    // still compare these regions against the previous frame) and collect
    // the absolute-overlay exclusion rects.
    const absoluteClears: Rectangle[] = []
    for (const op of this.operations) {
      if (op.type !== 'clear') continue
      const x0 = Math.max(0, op.region.x)
      const y0 = Math.max(0, op.region.y)
      const x1 = Math.min(op.region.x + op.region.width, W)
      const y1 = Math.min(op.region.y + op.region.height, H)
      if (x0 >= x1 || y0 >= y1) continue
      const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      screen.damage = screen.damage ? unionRect(screen.damage, rect) : rect
      clearArea += rect.width * rect.height
      if (op.fromAbsolute) absoluteClears.push(rect)
    }

    // Pass 2 — everything except clears (done) and noSelect (last).
    const clips: Clip[] = []
    for (const op of this.operations) {
      switch (op.type) {
        case 'clear':
          continue
        case 'clip':
          // Nested overflow clips intersect with their ancestors — a child's
          // own clip can extend past a scrolled ancestor's viewport.
          clips.push(intersectClip(clips.at(-1), op.clip))
          continue
        case 'unclip':
          clips.pop()
          continue
        case 'shift':
          shiftRows(screen, op.top, op.bottom, op.n)
          continue
        case 'shift-rect': {
          shiftRect(screen, op.top, op.bottom, op.x0, op.x1, op.n)
          const x0 = Math.max(0, op.x0)
          const x1 = Math.min(op.x1, W)
          const y0 = Math.max(0, op.top)
          const y1 = Math.min(op.bottom + 1, H)
          if (x0 < x1 && y0 < y1) {
            const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
            screen.damage = screen.damage ? unionRect(screen.damage, rect) : rect
          }
          continue
        }
        case 'blit': {
          // Clip-intersected: a child's clean-blit passes its full cached
          // rect, but the parent viewport may have shrunk since.
          const clip = clips.at(-1)
          const x0 = Math.max(op.x, clip?.x1 ?? 0)
          const y0 = Math.max(op.y, clip?.y1 ?? 0)
          const x1 = Math.min(op.x + op.width, W, op.src.width, clip?.x2 ?? Infinity)
          const y1 = Math.min(op.y + op.height, H, op.src.height, clip?.y2 ?? Infinity)
          if (x0 >= x1 || y0 >= y1) continue
          if (absoluteClears.length === 0) {
            blitRegion(screen, op.src, x0, y0, x1, y1)
            blitCells += (y1 - y0) * (x1 - x0)
            continue
          }
          // Skip rows a vacating absolute overlay covered — blitting them
          // would re-import its stale paint. Split into row bands.
          let bandStart = y0
          for (let row = y0; row <= y1; row++) {
            const excluded =
              row < y1 &&
              absoluteClears.some(
                r => row >= r.y && row < r.y + r.height && x0 >= r.x && x1 <= r.x + r.width,
              )
            if (excluded || row === y1) {
              if (row > bandStart) {
                blitRegion(screen, op.src, x0, bandStart, x1, row)
                blitCells += (row - bandStart) * (x1 - x0)
              }
              bandStart = row + 1
            }
          }
          continue
        }
        case 'write': {
          writeCells += this.applyWrite(op, clips.at(-1))
          continue
        }
        case 'noSelect':
          continue
      }
    }

    // Pass 3 — noSelect marks win over everything (blits copy the bitmap
    // from prevScreen; a moved fence must land on the final state).
    for (const op of this.operations) {
      if (op.type === 'noSelect') {
        markNoSelectRegion(screen, op.region.x, op.region.y, op.region.width, op.region.height)
      }
    }

    const total = blitCells + writeCells
    if (total > 1000 && writeCells > blitCells) {
      logForDebugging(
        `High write ratio: blit=${blitCells}, write=${writeCells} (${((writeCells / total) * 100).toFixed(1)}% writes), screen=${H}x${W}`,
      )
    }
    lastComposeCounts.blit = blitCells
    lastComposeCounts.write = writeCells
    lastComposeCounts.clearArea = clearArea
    lastComposeCounts.ops = this.operations.length
    return screen
  }

  // ── the text lane ─────────────────────────────────────────────────────────

  /** Apply one write op through the clip. Returns cells written (forensics). */
  private applyWrite(op: WriteOp, clip: Clip | undefined): number {
    let { x, y } = op
    let lines = op.text.split('\n')
    let swFrom = 0
    let prevContentEnd = 0

    if (clip) {
      const clipH = typeof clip.x1 === 'number' && typeof clip.x2 === 'number'
      const clipV = typeof clip.y1 === 'number' && typeof clip.y2 === 'number'

      // Entirely outside the clip → nothing to do.
      if (clipH) {
        const w = widestLine(op.text)
        if (x + w <= clip.x1! || x >= clip.x2!) return 0
      }
      if (clipV) {
        if (y + lines.length <= clip.y1! || y >= clip.y2!) return 0
      }

      if (clipH) {
        lines = lines.map(line => {
          const from = x < clip.x1! ? clip.x1! - x : 0
          const w = stringWidth(line)
          const to = x + w > clip.x2! ? clip.x2! - x : w
          let sliced = sliceAnsi(line, from, to)
          // A wide glyph straddling `to` makes sliceAnsi include the whole
          // glyph — one cell past the clip, into the neighbor pane. Wide
          // glyphs are exactly 2 cells, so one retry always fits.
          if (stringWidth(sliced) > to - from) {
            sliced = sliceAnsi(line, from, to - 1)
          }
          return sliced
        })
        if (x < clip.x1!) x = clip.x1!
      }

      if (clipV) {
        const from = y < clip.y1! ? clip.y1! - y : 0
        const to = y + lines.length > clip.y2! ? clip.y2! - y : lines.length
        // If the first visible line is a soft-wrap continuation, record the
        // clipped previous line's content end so the join point survives
        // even though that line's cells were never written. THROUGH-CLIP
        // records are NEGATED (see Screen.softWrap): the predecessor was
        // never painted, so the screen row above is unrelated static
        // content — extraction must neither join onto it nor clamp it
        // (the T7 header-join artifact); the capture flow still reads the
        // nonzero value as a continuation bit.
        if (op.softWrap && from > 0 && op.softWrap[from] === true) {
          prevContentEnd = -(x + stringWidth(lines[from - 1]!))
        }
        lines = lines.slice(from, to)
        swFrom = from
        if (y < clip.y1!) y = clip.y1!
      }
    }

    const screen = this.screen
    const swBits = screen.softWrap
    let written = 0
    for (let i = 0; i < lines.length; i++) {
      const lineY = y + i
      if (lineY >= this.height) break
      const contentEnd = this.writeLine(lines[i]!, x, lineY)
      written += contentEnd - x
      if (op.softWrap) {
        // See Screen.softWrap for the encoding: continuation rows record the
        // PREVIOUS line's content end (tab-expansion-aware, from writeLine;
        // NEGATIVE ⇒ through-clip — the predecessor was clipped above the
        // scroll viewport and never painted).
        swBits[lineY] = op.softWrap[swFrom + i] === true ? prevContentEnd : 0
        prevContentEnd = contentEnd
      }
    }
    return written
  }

  /** One line → cells. Returns the end column (tab-expansion-aware). */
  private writeLine(line: string, x: number, y: number): number {
    let clusters = this.clusterCache.get(line)
    if (!clusters) {
      clusters = reorderBidi(clusterStyledLine(line, this.stylePool))
      this.clusterCache.set(line, clusters)
    }

    const screen = this.screen
    const W = this.width
    const pool = this.stylePool
    let cx = x

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i]!
      const cp = cluster.value.codePointAt(0)

      // C0 controls never become cells — they'd desync the cursor model.
      if (cp !== undefined && cp <= 0x1f) {
        if (cp === 0x09) {
          // Tab: the RAW-ANSI BACKSTOP only (FN-016 R4). The text lane
          // pre-expands at composeText with the text-origin column — the
          // one width owner — so a tab reaching here rode a producer-
          // rendered ink-raw-ansi write, where the producer owns widths
          // and the absolute-column stop is the best remaining guess.
          // Dropping it with the other C0s would eat the cell entirely.
          const stop = 8 - (cx % 8)
          for (let s = 0; s < stop && cx < W; s++) {
            setCellAt(screen, cx, y, {
              char: ' ',
              styleId: pool.none,
              width: CellWidth.Narrow,
              hyperlink: undefined,
            })
            cx++
          }
        } else if (cp === 0x1b) {
          // A raw escape ansi-tokenize didn't recognize (it only parses SGR
          // + OSC 8). Skip the whole sequence by its public grammar so its
          // bytes never land in cells.
          i = skipEscapeSequence(clusters, i)
        }
        // CR/BS/BEL/other C0: skipped outright (writes are line-scoped).
        continue
      }

      const w = cluster.width
      if (w === 0) continue // zero-width: combining marks, ZWJ, ZWS

      const isWide = w >= 2
      if (isWide && cx + 2 > W) {
        // A wide glyph can't straddle the right edge — mark the blank
        // column the way the terminal's own wrap would.
        setCellAt(screen, cx, y, {
          char: ' ',
          styleId: pool.none,
          width: CellWidth.SpacerHead,
          hyperlink: undefined,
        })
        cx++
        continue
      }

      setCellAt(screen, cx, y, {
        char: cluster.value,
        styleId: cluster.styleId,
        width: isWide ? CellWidth.Wide : CellWidth.Narrow,
        hyperlink: cluster.hyperlink,
      })
      cx += isWide ? 2 : 1
    }
    return cx
  }
}

// ── tokenize → style-run grouping → grapheme clustering ────────────────────

function stylesEqual(a: AnsiCode[], b: AnsiCode[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.code !== b[i]!.code) return false
  }
  return true
}

/** Tokenize a line and produce width/style/link-annotated grapheme clusters.
 *  Style interning happens once per style RUN, not per character; OSC 8
 *  codes are lifted out of the style list into the hyperlink field (close
 *  codes too — the tokenizer treats them as active styles). */
function clusterStyledLine(line: string, pool: StylePool): ClusteredChar[] {
  const chars: StyledChar[] = styledCharsFromTokens(tokenize(line))
  if (chars.length === 0) return []

  const out: ClusteredChar[] = []
  let runChars: string[] = []
  let runStyles: AnsiCode[] = chars[0]!.styles

  const flushRun = (): void => {
    if (runChars.length === 0) return
    const buffer = runChars.join('')
    const hyperlink = extractHyperlinkFromStyles(runStyles) ?? undefined
    const hasOsc8 =
      hyperlink !== undefined ||
      runStyles.some(s => s.code.length >= OSC8_PREFIX.length && s.code.startsWith(OSC8_PREFIX))
    const styleId = pool.intern(hasOsc8 ? filterOutHyperlinkStyles(runStyles) : runStyles)
    for (const { segment } of getGraphemeSegmenter().segment(buffer)) {
      out.push({ value: segment, width: stringWidth(segment), styleId, hyperlink })
    }
    runChars = []
  }

  for (const ch of chars) {
    if (runChars.length > 0 && !stylesEqual(ch.styles, runStyles)) flushRun()
    runChars.push(ch.value)
    runStyles = ch.styles
  }
  flushRun()
  return out
}

/** Skip a non-SGR escape sequence starting at clusters[i] (an ESC cluster).
 *  Returns the index of the sequence's LAST cluster (the caller's loop
 *  increment steps past it). Grammar: charset selectors (ESC (X …), CSI to
 *  its final byte (0x40–0x7E), string sequences (OSC/DCS/APC/PM/SOS) to BEL
 *  or ST, single-char escapes (ESC 0x30–0x7E). */
function skipEscapeSequence(clusters: ClusteredChar[], i: number): number {
  const next = clusters[i + 1]?.value
  const nextCp = next?.codePointAt(0)
  if (next === '(' || next === ')' || next === '*' || next === '+') {
    return i + 2 // charset selection: intermediate + designator
  }
  if (next === '[') {
    i++ // the [
    while (i < clusters.length - 1) {
      i++
      const c = clusters[i]?.value.codePointAt(0)
      if (c !== undefined && c >= 0x40 && c <= 0x7e) break
    }
    return i
  }
  if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
    i++ // the introducer
    while (i < clusters.length - 1) {
      i++
      const c = clusters[i]?.value
      if (c === '\x07') break
      if (c === '\x1b' && clusters[i + 1]?.value === '\\') {
        i++
        break
      }
    }
    return i
  }
  if (nextCp !== undefined && nextCp >= 0x30 && nextCp <= 0x7e) {
    return i + 1 // single-character escape
  }
  return i
}
