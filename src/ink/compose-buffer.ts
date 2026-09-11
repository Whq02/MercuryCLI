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
import { lineWidth } from './line-width-cache.js'
import { stringWidth } from './stringWidth.js'
import { widestLine } from './widest-line.js'


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

export const lastComposeCounts = { blit: 0, write: 0, clearArea: 0, ops: 0 }

type Options = {
  width: number
  height: number
  stylePool: StylePool
  screen: Screen
}

export default class ComposeBuffer {
  width: number
  height: number
  private readonly stylePool: StylePool
  private screen: Screen
  private readonly operations: Operation[] = []
  private clusterCache: Map<string, ClusteredChar[]> = new Map()
  private sliceCache: Map<string, string> = new Map()

  constructor(options: Options) {
    this.width = options.width
    this.height = options.height
    this.stylePool = options.stylePool
    this.screen = options.screen
    resetScreen(this.screen, this.width, this.height)
  }

  reset(width: number, height: number, screen: Screen): void {
    this.width = width
    this.height = height
    this.screen = screen
    this.operations.length = 0
    resetScreen(screen, width, height)
    if (this.clusterCache.size > 16384) this.clusterCache.clear()
    if (this.sliceCache.size > 16384) this.sliceCache.clear()
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

  shift(top: number, bottom: number, n: number): void {
    this.operations.push({ type: 'shift', top, bottom, n })
  }

  shiftRect(top: number, bottom: number, x0: number, x1: number, n: number): void {
    this.operations.push({ type: 'shift-rect', top, bottom, x0, x1, n })
  }

  clear(region: Rectangle, fromAbsolute?: boolean): void {
    this.operations.push({ type: 'clear', region, fromAbsolute })
  }

  noSelect(region: Rectangle): void {
    this.operations.push({ type: 'noSelect', region })
  }

  get(): Screen {
    const screen = this.screen
    const W = this.width
    const H = this.height
    let blitCells = 0
    let writeCells = 0
    let clearArea = 0

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

    const clips: Clip[] = []
    for (const op of this.operations) {
      switch (op.type) {
        case 'clear':
          continue
        case 'clip':
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


  private applyWrite(op: WriteOp, clip: Clip | undefined): number {
    let { x, y } = op
    let lines = op.text.split('\n')
    let swFrom = 0
    let prevContentEnd = 0

    if (clip) {
      const clipH = typeof clip.x1 === 'number' && typeof clip.x2 === 'number'
      const clipV = typeof clip.y1 === 'number' && typeof clip.y2 === 'number'

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
          const w = lineWidth(line)
          const to = x + w > clip.x2! ? clip.x2! - x : w
          return this.clipLine(line, from, to)
        })
        if (x < clip.x1!) x = clip.x1!
      }

      if (clipV) {
        const from = y < clip.y1! ? clip.y1! - y : 0
        const to = y + lines.length > clip.y2! ? clip.y2! - y : lines.length
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
        swBits[lineY] = op.softWrap[swFrom + i] === true ? prevContentEnd : 0
        prevContentEnd = contentEnd
      }
    }
    return written
  }

  private clipLine(line: string, from: number, to: number): string {
    const key = `${from} ${to} ${line}`
    const hit = this.sliceCache.get(key)
    if (hit !== undefined) return hit
    let sliced = sliceAnsi(line, from, to)
    if (lineWidth(sliced) > to - from) {
      sliced = sliceAnsi(line, from, to - 1)
    }
    this.sliceCache.set(key, sliced)
    return sliced
  }

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

      if (cp !== undefined && cp <= 0x1f) {
        if (cp === 0x09) {
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
          i = skipEscapeSequence(clusters, i)
        }
        continue
      }

      const w = cluster.width
      if (w === 0) continue

      const isWide = w >= 2
      if (isWide && cx + 2 > W) {
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


function stylesEqual(a: AnsiCode[], b: AnsiCode[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.code !== b[i]!.code) return false
  }
  return true
}

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

function skipEscapeSequence(clusters: ClusteredChar[], i: number): number {
  const next = clusters[i + 1]?.value
  const nextCp = next?.codePointAt(0)
  if (next === '(' || next === ')' || next === '*' || next === '+') {
    return i + 2
  }
  if (next === '[') {
    i++
    while (i < clusters.length - 1) {
      i++
      const c = clusters[i]?.value.codePointAt(0)
      if (c !== undefined && c >= 0x40 && c <= 0x7e) break
    }
    return i
  }
  if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
    i++
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
    return i + 1
  }
  return i
}
