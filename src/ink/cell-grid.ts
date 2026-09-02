import {
  type AnsiCode,
  ansiCodesToString,
  diffAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import {
  type Point,
  type Rectangle,
  type Size,
  unionRect,
} from './layout/geometry.js'
import { BEL, ESC, SEP } from './termio/ansi.js'
import * as warn from './warn.js'


export class CharPool {
  private strings: string[] = [' ', '']
  private byString = new Map<string, number>([
    [' ', 0],
    ['', 1],
  ])
  private ascii = new Int32Array(128).fill(-1)

  constructor() {
    this.ascii[32] = 0
  }

  intern(char: string): number {
    if (char.length === 1) {
      const code = char.charCodeAt(0)
      if (code < 128) {
        const hit = this.ascii[code]!
        if (hit !== -1) return hit
        const id = this.strings.length
        this.strings.push(char)
        this.ascii[code] = id
        return id
      }
    }
    let id = this.byString.get(char)
    if (id === undefined) {
      id = this.strings.length
      this.strings.push(char)
      this.byString.set(char, id)
    }
    return id
  }

  get(index: number): string {
    return this.strings[index] ?? ' '
  }
}

export class HyperlinkPool {
  private strings: string[] = ['']
  private byString = new Map<string, number>()

  intern(hyperlink: string | undefined): number {
    if (!hyperlink) return 0
    let id = this.byString.get(hyperlink)
    if (id === undefined) {
      id = this.strings.length
      this.strings.push(hyperlink)
      this.byString.set(hyperlink, id)
    }
    return id
  }

  get(id: number): string | undefined {
    return id === 0 ? undefined : this.strings[id]
  }
}

const VISIBLE_ON_SPACE = new Set([
  '\x1b[49m',
  '\x1b[27m',
  '\x1b[24m',
  '\x1b[29m',
  '\x1b[55m',
])

const INVERSE_CODE: AnsiCode = { type: 'ansi', code: '\x1b[7m', endCode: '\x1b[27m' }
const BOLD_CODE: AnsiCode = { type: 'ansi', code: '\x1b[1m', endCode: '\x1b[22m' }
const UNDERLINE_CODE: AnsiCode = { type: 'ansi', code: '\x1b[4m', endCode: '\x1b[24m' }
const YELLOW_FG_CODE: AnsiCode = { type: 'ansi', code: '\x1b[33m', endCode: '\x1b[39m' }

export class StylePool {
  private ids = new Map<string, number>()
  private styles: AnsiCode[][] = []
  private transitionCache = new Map<number, string>()
  readonly none: number

  constructor() {
    this.none = this.intern([])
  }

  intern(styles: AnsiCode[]): number {
    const key = styles.length === 0 ? '' : styles.map(s => s.code).join('\0')
    let id = this.ids.get(key)
    if (id === undefined) {
      const raw = this.styles.length
      this.styles.push(styles.length === 0 ? [] : styles)
      let visible = 0
      for (const s of styles) {
        if (VISIBLE_ON_SPACE.has(s.endCode)) {
          visible = 1
          break
        }
      }
      id = (raw << 1) | visible
      this.ids.set(key, id)
    }
    return id
  }

  get(id: number): AnsiCode[] {
    return this.styles[id >>> 1] ?? []
  }

  transition(fromId: number, toId: number): string {
    if (fromId === toId) return ''
    const key = fromId * 0x100000 + toId
    let str = this.transitionCache.get(key)
    if (str === undefined) {
      str = ansiCodesToString(diffAnsiCodes(this.get(fromId), this.get(toId)))
      this.transitionCache.set(key, str)
    }
    return str
  }


  private inverseCache = new Map<number, number>()
  withInverse(baseId: number): number {
    let id = this.inverseCache.get(baseId)
    if (id === undefined) {
      const base = this.get(baseId)
      const alreadyInverse = base.some(c => c.endCode === '\x1b[27m')
      id = alreadyInverse ? baseId : this.intern([...base, INVERSE_CODE])
      this.inverseCache.set(baseId, id)
    }
    return id
  }

  private currentMatchCache = new Map<number, number>()
  withCurrentMatch(baseId: number): number {
    let id = this.currentMatchCache.get(baseId)
    if (id === undefined) {
      const base = this.get(baseId)
      const codes = base.filter(
        c => c.endCode !== '\x1b[39m' && c.endCode !== '\x1b[49m',
      )
      codes.push(YELLOW_FG_CODE)
      if (!base.some(c => c.endCode === '\x1b[27m')) codes.push(INVERSE_CODE)
      if (!base.some(c => c.endCode === '\x1b[22m')) codes.push(BOLD_CODE)
      if (!base.some(c => c.endCode === '\x1b[24m')) codes.push(UNDERLINE_CODE)
      id = this.intern(codes)
      this.currentMatchCache.set(baseId, id)
    }
    return id
  }

  private selectionBgCode: AnsiCode | null = null
  private selectionBgCache = new Map<number, number>()
  setSelectionBg(bg: AnsiCode | null): void {
    if (this.selectionBgCode?.code === bg?.code) return
    this.selectionBgCode = bg
    this.selectionBgCache.clear()
  }

  withSelectionBg(baseId: number): number {
    const bg = this.selectionBgCode
    if (bg === null) return this.withInverse(baseId)
    let id = this.selectionBgCache.get(baseId)
    if (id === undefined) {
      const kept = this.get(baseId).filter(
        c => c.endCode !== '\x1b[49m' && c.endCode !== '\x1b[27m',
      )
      kept.push(bg)
      id = this.intern(kept)
      this.selectionBgCache.set(baseId, id)
    }
    return id
  }


  private recessCfg: RecessTransform | null = null
  private recessCfgKey = ''
  private recessCache = new Map<number, number>()
  private recessIds = new Set<number>()
  private recessBudgetWarned = false

  setRecessTransform(cfg: RecessTransform | null): void {
    const key = cfg
      ? `${cfg.canvas.join(',')}|${cfg.ink.join(',')}|${cfg.quantize256 ? 1 : 0}`
      : ''
    if (key === this.recessCfgKey) return
    this.recessCfgKey = key
    this.recessCfg = cfg
    this.recessCache.clear()
    this.recessIds.clear()
  }

  withRecess(baseId: number): number {
    const cfg = this.recessCfg
    if (cfg === null) return baseId
    if (this.recessIds.has(baseId)) return baseId
    if (this.styles.length >= 16000) {
      if (!this.recessBudgetWarned) {
        this.recessBudgetWarned = true
        warn.once('style-pool near capacity — recess derivation degraded to identity')
      }
      return baseId
    }
    let id = this.recessCache.get(baseId)
    if (id === undefined) {
      const out: AnsiCode[] = []
      let sawFg = false
      for (const c of this.get(baseId)) {
        if (c.endCode === FG_END) {
          sawFg = true
          out.push(recessColorCode(c, 38, cfg))
        } else if (c.endCode === BG_END) {
          out.push(recessColorCode(c, 48, cfg))
        } else {
          out.push(c)
        }
      }
      if (!sawFg) {
        const [r, g, b] = mixToward(cfg.ink, cfg.canvas, RECESS_MIX)
        out.push(makeColorCode(38, r, g, b, cfg.quantize256))
      }
      id = this.intern(out)
      this.recessIds.add(id)
      this.recessCache.set(baseId, id)
    }
    return id
  }
}


export type RecessTransform = {
  canvas: readonly [number, number, number]
  ink: readonly [number, number, number]
  quantize256: boolean
}

export const RECESS_MIX = 0.5

const FG_END = '\x1b[39m'
const BG_END = '\x1b[49m'

export function mixToward(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ]
}

export function xterm256ToRgb(n: number): [number, number, number] | null {
  if (n < 16) return null
  if (n <= 231) {
    const i = n - 16
    const step = (v: number): number => (v === 0 ? 0 : 55 + v * 40)
    return [step(Math.floor(i / 36)), step(Math.floor((i % 36) / 6)), step(i % 6)]
  }
  if (n <= 255) {
    const v = 8 + 10 * (n - 232)
    return [v, v, v]
  }
  return null
}

export function rgbToXterm256(r: number, g: number, b: number): number {
  const level = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)))
  const cube = [level(r), level(g), level(b)]
  const cv = (v: number): number => (v === 0 ? 0 : 55 + v * 40)
  const cubeRgb = [cv(cube[0]!), cv(cube[1]!), cv(cube[2]!)]
  const gray = Math.max(0, Math.min(23, Math.round((0.299 * r + 0.587 * g + 0.114 * b - 8) / 10)))
  const gv = 8 + 10 * gray
  const dist = (a: number[], x: number, y: number, z: number): number =>
    (a[0]! - x) ** 2 + (a[1]! - y) ** 2 + (a[2]! - z) ** 2
  return dist(cubeRgb, r, g, b) <= dist([gv, gv, gv], r, g, b)
    ? 16 + 36 * cube[0]! + 6 * cube[1]! + cube[2]!
    : 232 + gray
}

function makeColorCode(
  base: 38 | 48,
  r: number,
  g: number,
  b: number,
  quantize256: boolean,
): AnsiCode {
  const code = quantize256
    ? `\x1b[${base};5;${rgbToXterm256(r, g, b)}m`
    : `\x1b[${base};2;${r};${g};${b}m`
  return { type: 'ansi', code, endCode: base === 38 ? FG_END : BG_END }
}

function recessColorCode(c: AnsiCode, base: 38 | 48, cfg: RecessTransform): AnsiCode {
  const m24 = new RegExp(`^\\x1b\\[${base};2;(\\d+);(\\d+);(\\d+)m$`).exec(c.code)
  if (m24) {
    const [r, g, b] = mixToward(
      [Number(m24[1]), Number(m24[2]), Number(m24[3])],
      cfg.canvas,
      RECESS_MIX,
    )
    return makeColorCode(base, r, g, b, cfg.quantize256)
  }
  const m256 = new RegExp(`^\\x1b\\[${base};5;(\\d+)m$`).exec(c.code)
  if (m256) {
    const rgb = xterm256ToRgb(Number(m256[1]))
    if (rgb === null) return c
    const [r, g, b] = mixToward(rgb, cfg.canvas, RECESS_MIX)
    return makeColorCode(base, r, g, b, true)
  }
  return c
}

export function remapStylesOutside(
  screen: Screen,
  rects: readonly Rectangle[],
  remap: (styleId: number) => number,
): number {
  const cells = screen.cells
  let changed = 0
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < screen.height; y++) {
    for (let x = 0; x < screen.width; x++) {
      let inside = false
      for (const r of rects) {
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
          inside = true
          break
        }
      }
      if (inside) continue
      const ci = (y * screen.width + x) << 1
      const word1 = cells[ci + 1]!
      if (cells[ci] === 0 && word1 === 0) continue
      const width = word1 & WIDTH_MASK
      if (width === CellWidth.SpacerTail || width === CellWidth.SpacerHead) continue
      const styleId = word1 >>> STYLE_SHIFT
      const next = remap(styleId)
      if (next === styleId) continue
      cells[ci + 1] = packWord1(next, (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK, width)
      if (changed === 0) {
        minX = x
        minY = y
        maxX = x + 1
        maxY = y + 1
      } else {
        if (x < minX) minX = x
        if (x + 1 > maxX) maxX = x + 1
        if (y < minY) minY = y
        if (y + 1 > maxY) maxY = y + 1
      }
      changed++
    }
  }
  if (changed > 0) trackDamage(screen, minX, minY, maxX, maxY)
  return changed
}


export const enum CellWidth {
  Narrow = 0,
  Wide = 1,
  SpacerTail = 2,
  SpacerHead = 3,
}

export type Hyperlink = string | undefined

export type Cell = {
  char: string
  styleId: number
  width: CellWidth
  hyperlink: Hyperlink
}

const STYLE_SHIFT = 17
const HYPERLINK_SHIFT = 2
const HYPERLINK_MASK = 0x7fff
const WIDTH_MASK = 3
const SPACE_VISIBLE_MASK = 0x3fffc

function packWord1(styleId: number, hyperlinkId: number, width: number): number {
  return (styleId << STYLE_SHIFT) | (hyperlinkId << HYPERLINK_SHIFT) | width
}

const EMPTY_CHAR_INDEX = 0
const SPACER_CHAR_INDEX = 1
const EMPTY_CELL_VALUE = 0n

export type Screen = Size & {
  cells: Int32Array
  cells64: BigInt64Array
  charPool: CharPool
  hyperlinkPool: HyperlinkPool
  emptyStyleId: number
  damage: Rectangle | undefined
  noSelect: Uint8Array
  softWrap: Int32Array
}


function sanitizeDim(v: number, label: string): number {
  warn.ifNotInteger(v, label)
  if (!Number.isInteger(v) || v < 0) return Math.max(0, Math.floor(v) || 0)
  return v
}

export function createScreen(
  width: number,
  height: number,
  styles: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Screen {
  width = sanitizeDim(width, 'createScreen width')
  height = sanitizeDim(height, 'createScreen height')
  const size = width * height
  const buf = new ArrayBuffer(size << 3)
  return {
    width,
    height,
    cells: new Int32Array(buf),
    cells64: new BigInt64Array(buf),
    charPool,
    hyperlinkPool,
    emptyStyleId: styles.none,
    damage: undefined,
    noSelect: new Uint8Array(size),
    softWrap: new Int32Array(height),
  }
}

export function resetScreen(screen: Screen, width: number, height: number): void {
  width = sanitizeDim(width, 'resetScreen width')
  height = sanitizeDim(height, 'resetScreen height')
  const size = width * height
  if (screen.cells64.length < size) {
    const buf = new ArrayBuffer(size << 3)
    screen.cells = new Int32Array(buf)
    screen.cells64 = new BigInt64Array(buf)
    screen.noSelect = new Uint8Array(size)
  }
  if (screen.softWrap.length < height) {
    screen.softWrap = new Int32Array(height)
  }
  screen.cells64.fill(EMPTY_CELL_VALUE, 0, size)
  screen.noSelect.fill(0, 0, size)
  screen.softWrap.fill(0, 0, height)
  screen.width = width
  screen.height = height
  screen.damage = undefined
}

export function migrateScreenPools(
  screen: Screen,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): void {
  const oldChars = screen.charPool
  const oldLinks = screen.hyperlinkPool
  if (oldChars === charPool && oldLinks === hyperlinkPool) return
  const cells = screen.cells
  const words = (screen.width * screen.height) << 1
  for (let ci = 0; ci < words; ci += 2) {
    cells[ci] = charPool.intern(oldChars.get(cells[ci]!))
    const word1 = cells[ci + 1]!
    const linkId = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK
    if (linkId !== 0) {
      cells[ci + 1] = packWord1(
        word1 >>> STYLE_SHIFT,
        hyperlinkPool.intern(oldLinks.get(linkId)),
        word1 & WIDTH_MASK,
      )
    }
  }
  screen.charPool = charPool
  screen.hyperlinkPool = hyperlinkPool
}


function trackDamage(screen: Screen, x0: number, y0: number, x1: number, y1: number): void {
  if (x1 <= x0 || y1 <= y0) return
  const d = screen.damage
  if (d === undefined) {
    screen.damage = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
    return
  }
  const nx0 = d.x < x0 ? d.x : x0
  const ny0 = d.y < y0 ? d.y : y0
  const right = d.x + d.width
  const bottom = d.y + d.height
  const nx1 = right > x1 ? right : x1
  const ny1 = bottom > y1 ? bottom : y1
  d.x = nx0
  d.y = ny0
  d.width = nx1 - nx0
  d.height = ny1 - ny0
}


export function cellAt(screen: Screen, x: number, y: number): Cell | undefined {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return undefined
  return cellAtIndex(screen, y * screen.width + x)
}

export function cellAtIndex(screen: Screen, index: number): Cell {
  const ci = index << 1
  const word1 = screen.cells[ci + 1]!
  const linkId = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK
  return {
    char: screen.charPool.get(screen.cells[ci]!),
    styleId: word1 >>> STYLE_SHIFT,
    width: word1 & WIDTH_MASK,
    hyperlink: linkId === 0 ? undefined : screen.hyperlinkPool.get(linkId),
  }
}

export function visibleCellAtIndex(
  cells: Int32Array,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  index: number,
  lastRenderedStyleId: number,
): Cell | undefined {
  const ci = index << 1
  const charId = cells[ci]!
  if (charId === SPACER_CHAR_INDEX) return undefined
  const word1 = cells[ci + 1]!
  if (charId === EMPTY_CHAR_INDEX && (word1 & SPACE_VISIBLE_MASK) === 0) {
    const fgStyle = word1 >>> STYLE_SHIFT
    if (fgStyle === 0 || fgStyle === lastRenderedStyleId) return undefined
  }
  const linkId = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK
  return {
    char: charPool.get(charId),
    styleId: word1 >>> STYLE_SHIFT,
    width: word1 & WIDTH_MASK,
    hyperlink: linkId === 0 ? undefined : hyperlinkPool.get(linkId),
  }
}

function decodeCellInto(screen: Screen, ci: number, out: Cell): void {
  const word1 = screen.cells[ci + 1]!
  out.char = screen.charPool.get(screen.cells[ci]!)
  out.styleId = word1 >>> STYLE_SHIFT
  out.width = word1 & WIDTH_MASK
  const linkId = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK
  out.hyperlink = linkId === 0 ? undefined : screen.hyperlinkPool.get(linkId)
}

export function charInCellAt(screen: Screen, x: number, y: number): string | undefined {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return undefined
  return screen.charPool.get(screen.cells[(y * screen.width + x) << 1]!)
}

function isEmptyCellByIndex(screen: Screen, index: number): boolean {
  const ci = index << 1
  return screen.cells[ci] === 0 && screen.cells[ci + 1] === 0
}

export function isEmptyCellAt(screen: Screen, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return true
  return isEmptyCellByIndex(screen, y * screen.width + x)
}


function blankCell(screen: Screen, ci: number): void {
  screen.cells[ci] = EMPTY_CHAR_INDEX
  screen.cells[ci + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow)
}

function repairWideSplit(screen: Screen, x: number, y: number, incomingWidth: CellWidth): number {
  const cells = screen.cells
  const ci = (y * screen.width + x) << 1
  const prevWidth = cells[ci + 1]! & WIDTH_MASK
  let minRepairedX = x

  if (prevWidth === CellWidth.Wide && incomingWidth !== CellWidth.Wide) {
    if (x + 1 < screen.width && (cells[ci + 3]! & WIDTH_MASK) === CellWidth.SpacerTail) {
      blankCell(screen, ci + 2)
      trackDamage(screen, x + 1, y, x + 2, y + 1)
    }
  }
  if (prevWidth === CellWidth.SpacerTail && incomingWidth !== CellWidth.SpacerTail) {
    if (x > 0 && (cells[ci - 1]! & WIDTH_MASK) === CellWidth.Wide) {
      blankCell(screen, ci - 2)
      minRepairedX = x - 1
    }
  }
  if (incomingWidth === CellWidth.Wide && x + 1 < screen.width) {
    if ((cells[ci + 3]! & WIDTH_MASK) === CellWidth.Wide) {
      if (x + 2 < screen.width && (cells[ci + 5]! & WIDTH_MASK) === CellWidth.SpacerTail) {
        blankCell(screen, ci + 4)
        trackDamage(screen, x + 2, y, x + 3, y + 1)
      }
    }
  }
  return minRepairedX
}


export function setCellAt(screen: Screen, x: number, y: number, cell: Cell): void {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return
  const cells = screen.cells
  const ci = (y * screen.width + x) << 1

  const minRepairedX = repairWideSplit(screen, x, y, cell.width)

  cells[ci] = screen.charPool.intern(cell.char)
  cells[ci + 1] = packWord1(
    cell.styleId,
    screen.hyperlinkPool.intern(cell.hyperlink),
    cell.width,
  )

  let maxX = x + 1
  if (cell.width === CellWidth.Wide && x + 1 < screen.width) {
    cells[ci + 2] = SPACER_CHAR_INDEX
    cells[ci + 3] = packWord1(screen.emptyStyleId, 0, CellWidth.SpacerTail)
    maxX = x + 2
  }
  trackDamage(screen, minRepairedX, y, maxX, y + 1)
}

export function setCellStyleId(screen: Screen, x: number, y: number, styleId: number): void {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return
  const ci = (y * screen.width + x) << 1
  const word1 = screen.cells[ci + 1]!
  const width = word1 & WIDTH_MASK
  if (width === CellWidth.SpacerTail || width === CellWidth.SpacerHead) return
  screen.cells[ci + 1] = packWord1(
    styleId,
    (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK,
    width,
  )
  trackDamage(screen, x, y, x + 1, y + 1)
}


export function blitRegion(
  dst: Screen,
  src: Screen,
  regionX: number,
  regionY: number,
  maxX: number,
  maxY: number,
): void {
  regionX = Math.max(0, regionX)
  regionY = Math.max(0, regionY)
  if (regionX >= maxX || regionY >= maxY) return

  const rowLen = maxX - regionX
  const srcStride = src.width << 1
  const dstStride = dst.width << 1

  dst.softWrap.set(src.softWrap.subarray(regionY, maxY), regionY)

  if (regionX === 0 && maxX === src.width && src.width === dst.width) {
    const start = regionY * srcStride
    dst.cells.set(src.cells.subarray(start, start + (maxY - regionY) * srcStride), start)
    const nsStart = regionY * src.width
    dst.noSelect.set(src.noSelect.subarray(nsStart, nsStart + (maxY - regionY) * src.width), nsStart)
  } else {
    let srcCI = regionY * srcStride + (regionX << 1)
    let dstCI = regionY * dstStride + (regionX << 1)
    let srcNS = regionY * src.width + regionX
    let dstNS = regionY * dst.width + regionX
    const rowWords = rowLen << 1
    for (let y = regionY; y < maxY; y++) {
      dst.cells.set(src.cells.subarray(srcCI, srcCI + rowWords), dstCI)
      dst.noSelect.set(src.noSelect.subarray(srcNS, srcNS + rowLen), dstNS)
      srcCI += srcStride
      dstCI += dstStride
      srcNS += src.width
      dstNS += dst.width
    }
  }

  let damageMaxX = maxX
  if (maxX < dst.width) {
    let srcHeadCI = (regionY * src.width + (maxX - 1)) << 1
    let dstTailCI = (regionY * dst.width + maxX) << 1
    let completed = false
    for (let y = regionY; y < maxY; y++) {
      if ((src.cells[srcHeadCI + 1]! & WIDTH_MASK) === CellWidth.Wide) {
        dst.cells[dstTailCI] = SPACER_CHAR_INDEX
        dst.cells[dstTailCI + 1] = packWord1(dst.emptyStyleId, 0, CellWidth.SpacerTail)
        completed = true
      }
      srcHeadCI += srcStride
      dstTailCI += dstStride
    }
    if (completed) damageMaxX = maxX + 1
  }
  trackDamage(dst, regionX, regionY, damageMaxX, maxY)
}

export function clearRegion(
  screen: Screen,
  regionX: number,
  regionY: number,
  regionWidth: number,
  regionHeight: number,
): void {
  const startX = Math.max(0, regionX)
  const startY = Math.max(0, regionY)
  const maxX = Math.min(regionX + regionWidth, screen.width)
  const maxY = Math.min(regionY + regionHeight, screen.height)
  if (startX >= maxX || startY >= maxY) return

  const cells = screen.cells
  const w = screen.width
  let damageMinX = startX
  let damageMaxX = maxX

  if (startX === 0 && maxX === w) {
    screen.cells64.fill(EMPTY_CELL_VALUE, startY * w, maxY * w)
  } else {
    for (let y = startY; y < maxY; y++) {
      const rowBase = y * w
      if (startX > 0) {
        const ci = (rowBase + startX) << 1
        if (
          (cells[ci + 1]! & WIDTH_MASK) === CellWidth.SpacerTail &&
          (cells[ci - 1]! & WIDTH_MASK) === CellWidth.Wide
        ) {
          blankCell(screen, ci - 2)
          damageMinX = startX - 1
        }
      }
      if (maxX < w) {
        const headCI = (rowBase + maxX - 1) << 1
        if (
          (cells[headCI + 1]! & WIDTH_MASK) === CellWidth.Wide &&
          (cells[headCI + 3]! & WIDTH_MASK) === CellWidth.SpacerTail
        ) {
          blankCell(screen, headCI + 2)
          damageMaxX = maxX + 1
        }
      }
      screen.cells64.fill(EMPTY_CELL_VALUE, rowBase + startX, rowBase + maxX)
    }
  }
  trackDamage(screen, damageMinX, startY, damageMaxX, maxY)
}

export function shiftRows(screen: Screen, top: number, bottom: number, n: number): void {
  if (n === 0 || top < 0 || bottom >= screen.height || top > bottom) return
  const w = screen.width
  const { cells64, noSelect: noSel, softWrap: sw } = screen
  if (Math.abs(n) > bottom - top) {
    cells64.fill(EMPTY_CELL_VALUE, top * w, (bottom + 1) * w)
    noSel.fill(0, top * w, (bottom + 1) * w)
    sw.fill(0, top, bottom + 1)
    return
  }
  if (n > 0) {
    cells64.copyWithin(top * w, (top + n) * w, (bottom + 1) * w)
    noSel.copyWithin(top * w, (top + n) * w, (bottom + 1) * w)
    sw.copyWithin(top, top + n, bottom + 1)
    cells64.fill(EMPTY_CELL_VALUE, (bottom - n + 1) * w, (bottom + 1) * w)
    noSel.fill(0, (bottom - n + 1) * w, (bottom + 1) * w)
    sw.fill(0, bottom - n + 1, bottom + 1)
  } else {
    cells64.copyWithin((top - n) * w, top * w, (bottom + n + 1) * w)
    noSel.copyWithin((top - n) * w, top * w, (bottom + n + 1) * w)
    sw.copyWithin(top - n, top, bottom + n + 1)
    cells64.fill(EMPTY_CELL_VALUE, top * w, (top - n) * w)
    noSel.fill(0, top * w, (top - n) * w)
    sw.fill(0, top, top - n)
  }
}

export function shiftRect(
  screen: Screen,
  top: number,
  bottom: number,
  x0: number,
  x1: number,
  n: number,
): void {
  if (n === 0 || top < 0 || bottom >= screen.height || top > bottom) return
  const w = screen.width
  const cx0 = Math.max(0, Math.floor(x0))
  const cx1 = Math.min(w, Math.floor(x1))
  if (cx1 <= cx0) return
  const { cells64, noSelect: noSel, softWrap: sw } = screen
  if (Math.abs(n) > bottom - top) {
    for (let r = top; r <= bottom; r++) {
      cells64.fill(EMPTY_CELL_VALUE, r * w + cx0, r * w + cx1)
      noSel.fill(0, r * w + cx0, r * w + cx1)
    }
    sw.fill(0, top, bottom + 1)
    return
  }
  if (n > 0) {
    for (let r = top; r <= bottom - n; r++) {
      cells64.copyWithin(r * w + cx0, (r + n) * w + cx0, (r + n) * w + cx1)
      noSel.copyWithin(r * w + cx0, (r + n) * w + cx0, (r + n) * w + cx1)
    }
    for (let r = bottom - n + 1; r <= bottom; r++) {
      cells64.fill(EMPTY_CELL_VALUE, r * w + cx0, r * w + cx1)
      noSel.fill(0, r * w + cx0, r * w + cx1)
    }
  } else {
    for (let r = bottom; r >= top - n; r--) {
      cells64.copyWithin(r * w + cx0, (r + n) * w + cx0, (r + n) * w + cx1)
      noSel.copyWithin(r * w + cx0, (r + n) * w + cx0, (r + n) * w + cx1)
    }
    for (let r = top; r < top - n; r++) {
      cells64.fill(EMPTY_CELL_VALUE, r * w + cx0, r * w + cx1)
      noSel.fill(0, r * w + cx0, r * w + cx1)
    }
  }
  sw.fill(0, top, bottom + 1)
}

export function markNoSelectRegion(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const maxX = Math.min(x + width, screen.width)
  const maxY = Math.min(y + height, screen.height)
  const stride = screen.width
  for (let row = Math.max(0, y); row < maxY; row++) {
    screen.noSelect.fill(1, row * stride + Math.max(0, x), row * stride + maxX)
  }
}


const OSC8_REGEX = new RegExp(`^${ESC}\\]8${SEP}${SEP}([^${BEL}]*)${BEL}$`)
export const OSC8_PREFIX = `${ESC}]8${SEP}`

export function extractHyperlinkFromStyles(styles: AnsiCode[]): Hyperlink | null {
  for (const style of styles) {
    const code = style.code
    if (code.length < 5 || !code.startsWith(OSC8_PREFIX)) continue
    const match = code.match(OSC8_REGEX)
    if (match) return match[1] || null
  }
  return null
}

export function filterOutHyperlinkStyles(styles: AnsiCode[]): AnsiCode[] {
  return styles.filter(
    style => !style.code.startsWith(OSC8_PREFIX) || !OSC8_REGEX.test(style.code),
  )
}


type DiffCallback = (
  x: number,
  y: number,
  removed: Cell | undefined,
  added: Cell | undefined,
) => boolean | void

export function diff(
  prev: Screen,
  next: Screen,
): [point: Point, removed: Cell | undefined, added: Cell | undefined][] {
  const out: [Point, Cell | undefined, Cell | undefined][] = []
  diffEach(prev, next, (x, y, removed, added) => {
    out.push([{ x, y }, removed ? { ...removed } : undefined, added ? { ...added } : undefined])
  })
  return out
}

export function diffEach(prev: Screen, next: Screen, cb: DiffCallback): boolean {
  let region: Rectangle
  if (prev.width === 0 && prev.height === 0) {
    region = { x: 0, y: 0, width: next.width, height: next.height }
  } else if (next.damage) {
    region = prev.damage ? unionRect(next.damage, prev.damage) : next.damage
  } else if (prev.damage) {
    region = prev.damage
  } else {
    region = { x: 0, y: 0, width: 0, height: 0 }
  }
  if (prev.height > next.height) {
    region = unionRect(region, {
      x: 0,
      y: next.height,
      width: prev.width,
      height: prev.height - next.height,
    })
  }
  if (prev.width > next.width) {
    region = unionRect(region, {
      x: next.width,
      y: 0,
      width: prev.width - next.width,
      height: prev.height,
    })
  }

  const endY = Math.min(region.y + region.height, Math.max(prev.height, next.height))
  const endX = Math.min(region.x + region.width, Math.max(prev.width, next.width))

  const removedView: Cell = { char: ' ', styleId: 0, width: CellWidth.Narrow, hyperlink: undefined }
  const addedView: Cell = { char: ' ', styleId: 0, width: CellWidth.Narrow, hyperlink: undefined }

  if (prev.width === next.width) {
    return walkSameWidth(prev, next, region.x, endX, region.y, endY, removedView, addedView, cb)
  }
  return walkResize(prev, next, region.x, endX, region.y, endY, removedView, addedView, cb)
}

function equalRun(a: Int32Array, b: Int32Array, w0: number, count: number): number {
  for (let i = 0; i < count; i++, w0 += 2) {
    if (a[w0] !== b[w0] || a[w0 + 1] !== b[w0 + 1]) return i
  }
  return count
}

function walkSameWidth(
  prev: Screen,
  next: Screen,
  startX: number,
  endX: number,
  startY: number,
  endY: number,
  removedView: Cell,
  addedView: Cell,
  cb: DiffCallback,
): boolean {
  const w = prev.width
  const stride = w << 1
  const rowEndX = Math.min(endX, w)
  let rowCI = (startY * w + startX) << 1

  for (let y = startY; y < endY; y++, rowCI += stride) {
    const prevIn = y < prev.height
    const nextIn = y < next.height
    if (prevIn && nextIn) {
      let x = startX
      let ci = rowCI
      while (x < rowEndX) {
        const skip = equalRun(prev.cells, next.cells, ci, rowEndX - x)
        x += skip
        ci += skip << 1
        if (x >= rowEndX) break
        decodeCellInto(prev, ci, removedView)
        decodeCellInto(next, ci, addedView)
        if (cb(x, y, removedView, addedView)) return true
        x++
        ci += 2
      }
    } else if (prevIn) {
      let ci = rowCI
      for (let x = startX; x < rowEndX; x++, ci += 2) {
        decodeCellInto(prev, ci, removedView)
        if (cb(x, y, removedView, undefined)) return true
      }
    } else if (nextIn) {
      let ci = rowCI
      for (let x = startX; x < rowEndX; x++, ci += 2) {
        if (next.cells[ci] === 0 && next.cells[ci + 1] === 0) continue
        decodeCellInto(next, ci, addedView)
        if (cb(x, y, undefined, addedView)) return true
      }
    }
  }
  return false
}

function walkResize(
  prev: Screen,
  next: Screen,
  startX: number,
  endX: number,
  startY: number,
  endY: number,
  removedView: Cell,
  addedView: Cell,
  cb: DiffCallback,
): boolean {
  const prevStride = prev.width << 1
  const nextStride = next.width << 1
  let prevRowCI = (startY * prev.width + startX) << 1
  let nextRowCI = (startY * next.width + startX) << 1

  for (let y = startY; y < endY; y++, prevRowCI += prevStride, nextRowCI += nextStride) {
    const prevEndX = y < prev.height ? Math.min(endX, prev.width) : startX
    const nextEndX = y < next.height ? Math.min(endX, next.width) : startX
    const bothEndX = Math.min(prevEndX, nextEndX)

    let prevCI = prevRowCI
    let nextCI = nextRowCI
    for (let x = startX; x < bothEndX; x++, prevCI += 2, nextCI += 2) {
      if (
        prev.cells[prevCI] === next.cells[nextCI] &&
        prev.cells[prevCI + 1] === next.cells[nextCI + 1]
      ) {
        continue
      }
      decodeCellInto(prev, prevCI, removedView)
      decodeCellInto(next, nextCI, addedView)
      if (cb(x, y, removedView, addedView)) return true
    }
    for (let x = bothEndX; x < prevEndX; x++, prevCI += 2) {
      decodeCellInto(prev, prevCI, removedView)
      if (cb(x, y, removedView, undefined)) return true
    }
    for (let x = bothEndX; x < nextEndX; x++, nextCI += 2) {
      if (next.cells[nextCI] === 0 && next.cells[nextCI + 1] === 0) continue
      decodeCellInto(next, nextCI, addedView)
      if (cb(x, y, undefined, addedView)) return true
    }
  }
  return false
}
