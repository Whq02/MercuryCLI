import {
  type AnsiCode,
  type StyledChar,
  styledCharsFromTokens,
  tokenize,
} from '@alcalzone/ansi-tokenize'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { getGraphemeSegmenter } from '../../platform/text/textSegments.js'
import sliceAnsi from '../../platform/text/sliceAnsi.js'
import { reorderBidi } from './bidi.js'
import { type Rectangle, unionRect } from './layout/geometry.js'
import {
  blitRegion,
  CellWidth,
  extractHyperlinkFromStyles,
  fillRegion,
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
import { terminalTextCells } from './terminal-session/terminalTextCells.js'
import { stringWidth } from './stringWidth.js'
import { widestLine } from './widest-line.js'


type ClusteredChar = {
  value: string
  width: number
  styleId: number
  hyperlink: string | undefined
}

type Clip = {
  x1?: number | undefined
  x2?: number | undefined
  y1?: number | undefined
  y2?: number | undefined
}

type WriteOp = {
  type: 'write'
  x: number
  y: number
  text: string
  softWrap?: boolean[]
}
type FillOp = {
  type: 'fill'
  x: number
  y: number
  width: number
  height: number
  styleId: number
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

type Operation =
  | WriteOp
  | FillOp
  | ClipOp
  | UnclipOp
  | BlitOp
  | ClearOp
  | NoSelectOp
  | ShiftOp
  | ShiftRectOp

export const lastComposeCounts = {
  blit: 0,
  write: 0,
  fill: 0,
  clearArea: 0,
  ops: 0,
}

type Options = {
  width: number
  height: number
  stylePool: StylePool
  screen: Screen
}

const CLUSTER_CACHE_LIMIT = 16384
const SLICE_CACHE_LIMIT = 16384
const FILL_STYLE_CACHE_LIMIT = 1024

function intersectBound(
  a: number | undefined,
  b: number | undefined,
  pick: (x: number, y: number) => number,
): number | undefined {
  if (a === undefined) return b
  return b === undefined ? a : pick(a, b)
}

function intersectClips(outer: Clip | undefined, inner: Clip): Clip {
  if (!outer) return inner
  return {
    x1: intersectBound(outer.x1, inner.x1, Math.max),
    x2: intersectBound(outer.x2, inner.x2, Math.min),
    y1: intersectBound(outer.y1, inner.y1, Math.max),
    y2: intersectBound(outer.y2, inner.y2, Math.min),
  }
}

function addDamage(screen: Screen, rect: Rectangle): void {
  screen.damage = screen.damage ? unionRect(screen.damage, rect) : rect
}

function writeLineToScreen(
  screen: Screen,
  stylePool: StylePool,
  clusterCache: Map<string, ClusteredChar[]>,
  bufWidth: number,
  line: string,
  startX: number,
  row: number,
): number {
  let clusters = clusterCache.get(line)
  if (clusters === undefined) {
    clusters = reorderBidi(clusterStyledLine(line, stylePool))
    clusterCache.set(line, clusters)
  }
  let col = startX
  const noneStyle = stylePool.none
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i]!
    const code = cluster.value.charCodeAt(0)
    if (code < 0x20) {
      if (code === 0x09) {
        const nextStop = Math.min(bufWidth, col + (8 - (((col % 8) + 8) % 8)))
        while (col < nextStop) {
          setCellAt(screen, col, row, {
            char: ' ',
            styleId: noneStyle,
            width: CellWidth.Narrow,
            hyperlink: undefined,
          })
          col++
        }
      } else if (code === 0x1b) {
        i = skipEscapeSequence(clusters, i)
      }
      continue
    }
    if (cluster.width === 0) continue
    if (cluster.width >= 2) {
      if (col + 2 > bufWidth) {
        setCellAt(screen, col, row, {
          char: ' ',
          styleId: noneStyle,
          width: CellWidth.SpacerHead,
          hyperlink: undefined,
        })
        col++
      } else {
        setCellAt(screen, col, row, {
          char: cluster.value,
          styleId: cluster.styleId,
          width: CellWidth.Wide,
          hyperlink: cluster.hyperlink,
        })
        col += 2
      }
    } else {
      setCellAt(screen, col, row, {
        char: cluster.value,
        styleId: cluster.styleId,
        width: CellWidth.Narrow,
        hyperlink: cluster.hyperlink,
      })
      col++
    }
  }
  return col
}

export default class ComposeBuffer {
  width: number
  height: number
  private readonly stylePool: StylePool
  private screen: Screen
  private readonly operations: Operation[] = []
  private clusterCache: Map<string, ClusteredChar[]> = new Map()
  private sliceCache: Map<string, string> = new Map()
  private fillStyleCache: Map<string, number> = new Map()

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
    if (this.clusterCache.size > CLUSTER_CACHE_LIMIT) this.clusterCache.clear()
    if (this.sliceCache.size > SLICE_CACHE_LIMIT) this.sliceCache.clear()
    if (this.fillStyleCache.size > FILL_STYLE_CACHE_LIMIT) this.fillStyleCache.clear()
    resetScreen(this.screen, width, height)
  }

  write(x: number, y: number, text: string, softWrap?: boolean[]): void {
    if (!text) return
    this.operations.push({ type: 'write', x, y, text, softWrap })
  }

  fill(x: number, y: number, width: number, height: number, styledSpace?: string): void {
    if (width <= 0 || height <= 0) return
    let styleId = this.stylePool.none
    if (styledSpace !== undefined) {
      const cached = this.fillStyleCache.get(styledSpace)
      if (cached !== undefined) {
        styleId = cached
      } else {
        const clusters = clusterStyledLine(styledSpace, this.stylePool)
        styleId = clusters[0]?.styleId ?? this.stylePool.none
        this.fillStyleCache.set(styledSpace, styleId)
      }
    }
    this.operations.push({ type: 'fill', x, y, width, height, styleId })
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
    let clearArea = 0
    for (const op of this.operations) {
      if (op.type !== 'clear') continue
      const { region } = op
      const x0 = Math.max(0, region.x)
      const y0 = Math.max(0, region.y)
      const x1 = Math.min(this.width, region.x + region.width)
      const y1 = Math.min(this.height, region.y + region.height)
      if (x1 > x0 && y1 > y0) {
        addDamage(this.screen, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
        clearArea += (x1 - x0) * (y1 - y0)
      }
    }

    const clips: Clip[] = []
    let blitCells = 0
    let writeCells = 0
    let fillCells = 0

    for (const op of this.operations) {
      switch (op.type) {
        case 'clip':
          clips.push(intersectClips(clips[clips.length - 1], op.clip))
          break
        case 'unclip':
          clips.pop()
          break
        case 'shift':
          shiftRows(this.screen, op.top, op.bottom, op.n)
          break
        case 'shift-rect': {
          shiftRect(this.screen, op.top, op.bottom, op.x0, op.x1, op.n)
          const rx0 = Math.max(0, op.x0)
          const ry0 = Math.max(0, op.top)
          const rx1 = Math.min(this.width, op.x1)
          const ry1 = Math.min(this.height, op.bottom + 1)
          if (rx1 > rx0 && ry1 > ry0) {
            addDamage(this.screen, { x: rx0, y: ry0, width: rx1 - rx0, height: ry1 - ry0 })
          }
          break
        }
        case 'blit': {
          const active = clips[clips.length - 1]
          const x0 = Math.max(op.x, active?.x1 ?? 0)
          const y0 = Math.max(op.y, active?.y1 ?? 0)
          let x1 = Math.min(op.x + op.width, this.width, op.src.width)
          let y1 = Math.min(op.y + op.height, this.height, op.src.height)
          if (active?.x2 !== undefined) x1 = Math.min(x1, active.x2)
          if (active?.y2 !== undefined) y1 = Math.min(y1, active.y2)
          if (x1 > x0 && y1 > y0) {
            blitRegion(this.screen, op.src, x0, y0, x1, y1)
            blitCells += (x1 - x0) * (y1 - y0)
          }
          break
        }
        case 'fill': {
          const active = clips[clips.length - 1]
          const x0 = Math.max(op.x, active?.x1 ?? 0)
          const y0 = Math.max(op.y, active?.y1 ?? 0)
          let x1 = Math.min(op.x + op.width, this.width)
          let y1 = Math.min(op.y + op.height, this.height)
          if (active?.x2 !== undefined) x1 = Math.min(x1, active.x2)
          if (active?.y2 !== undefined) y1 = Math.min(y1, active.y2)
          if (x1 > x0 && y1 > y0) {
            fillRegion(this.screen, x0, y0, x1 - x0, y1 - y0, op.styleId)
            fillCells += (x1 - x0) * (y1 - y0)
          }
          break
        }
        case 'write':
          writeCells += this.applyWrite(op, clips[clips.length - 1])
          break
        case 'clear':
        case 'noSelect':
          break
      }
    }

    for (const op of this.operations) {
      if (op.type !== 'noSelect') continue
      const { x, y, width, height } = op.region
      markNoSelectRegion(this.screen, x, y, width, height)
    }

    const total = blitCells + writeCells
    if (total > 1000 && writeCells > blitCells) {
      const pct = ((writeCells / total) * 100).toFixed(1)
      logForDebugging(
        `High write ratio: blit=${blitCells}, write=${writeCells} (${pct}% writes), screen=${this.height}x${this.width}`,
      )
    }

    lastComposeCounts.blit = blitCells
    lastComposeCounts.write = writeCells
    lastComposeCounts.fill = fillCells
    lastComposeCounts.clearArea = clearArea
    lastComposeCounts.ops = this.operations.length

    return this.screen
  }

  private clipLine(line: string, x: number, x1: number, x2: number): string {
    const width = lineWidth(line)
    const from = x < x1 ? x1 - x : 0
    const to = x + width > x2 ? x2 - x : width
    if (from >= to) return ''
    if (from === 0 && to === width) return line
    const key = `${from}:${to}:${line}`
    const cached = this.sliceCache.get(key)
    if (cached !== undefined) return cached
    let sliced = sliceAnsi(line, from, to)
    if (stringWidth(sliced) > to - from) {
      sliced = sliceAnsi(line, from, to - 1)
    }
    this.sliceCache.set(key, sliced)
    return sliced
  }

  private applyWrite(op: WriteOp, clip: Clip | undefined): number {
    let { x, y } = op
    const { text, softWrap } = op
    let lines = text.split('\n')
    let softWrapOffset = 0
    let prevLineEnd = 0

    if (clip) {
      const clipX = typeof clip.x1 === 'number' && typeof clip.x2 === 'number'
      const clipY = typeof clip.y1 === 'number' && typeof clip.y2 === 'number'

      if (clipX) {
        if (clip.x1! >= clip.x2!) return 0
        const width = widestLine(text)
        if (x + width <= clip.x1! || x >= clip.x2!) return 0
      }

      if (clipY) {
        if (clip.y1! >= clip.y2!) return 0
        if (y + lines.length <= clip.y1! || y >= clip.y2!) return 0
      }

      if (clipX) {
        lines = lines.map(line => this.clipLine(line, x, clip.x1!, clip.x2!))
        if (x < clip.x1!) x = clip.x1!
      }

      if (clipY) {
        const from = y < clip.y1! ? clip.y1! - y : 0
        const to = y + lines.length > clip.y2! ? clip.y2! - y : lines.length
        if (softWrap && from > 0 && softWrap[from]) {
          prevLineEnd = -(x + stringWidth(lines[from - 1]!))
        }
        lines = lines.slice(from, to)
        softWrapOffset = from
        if (y < clip.y1!) y = clip.y1!
      }
    }

    let written = 0
    for (let i = 0; i < lines.length; i++) {
      const row = y + i
      if (row >= this.height) break
      const endCol = writeLineToScreen(
        this.screen,
        this.stylePool,
        this.clusterCache,
        this.width,
        lines[i]!,
        x,
        row,
      )
      written += endCol - x
      if (softWrap !== undefined && row >= 0) {
        this.screen.softWrap[row] = softWrap[softWrapOffset + i] ? prevLineEnd : 0
      }
      prevLineEnd = endCol
    }
    return written
  }
}


function firstCodeMismatch(a: AnsiCode[], b: AnsiCode[]): number {
  let at = 0
  while (at < a.length && a[at]!.code === b[at]!.code) at++
  return at < a.length ? at : -1
}

const stylesEqual = (a: AnsiCode[], b: AnsiCode[]): boolean =>
  a === b || (a.length === b.length && firstCodeMismatch(a, b) < 0)

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
      const width = stringWidth(segment)
      const parts = width > 2 && /[\u200C\u200D]/.test(segment) && terminalTextCells().joinerCells > 0
        ? segment.split(/([\u200C\u200D])/).filter(Boolean)
        : [segment]
      for (const value of parts) {
        out.push({ value, width: parts.length === 1 ? width : stringWidth(value), styleId, hyperlink })
      }
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
