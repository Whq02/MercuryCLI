import { type AnsiCode, ansiCodesToString, diffAnsiCodes } from '@alcalzone/ansi-tokenize'
import type { Point, Rectangle, Size } from './layout/geometry.js'
import { BEL, ESC, SEP } from './termio/ansi.js'
import * as warn from './warn.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export const enum CellWidth { Narrow = 0, Wide = 1, SpacerTail = 2, SpacerHead = 3 }

type Link = string

export type Hyperlink = Link | undefined

export type Cell = { char: string; styleId: number; width: CellWidth; hyperlink: Hyperlink }

type CellPlanes = { cells: Int32Array; cells64: BigInt64Array; noSelect: Uint8Array }

type GridPools = { charPool: CharPool; hyperlinkPool: HyperlinkPool }

export type Screen = Size & CellPlanes & GridPools & { emptyStyleId: number; damage: Rectangle | undefined; softWrap: Int32Array }

const STYLE_OFFSET = 17
const LINK_OFFSET = 2
const LINK_MASK = 0x7fff
const WIDTH_BITS = 3
const SPACE_VISIBLE_MASK = 0x3fffc
const BLANK_GLYPH = 0
const SPACER_GLYPH = 1
const EMPTY_CELL = 0n

const packWord = (styleId: number, linkId: number, width: number): number => (styleId << STYLE_OFFSET) | (linkId << LINK_OFFSET) | width
const linkOf = (word: number): number => (word >>> LINK_OFFSET) & LINK_MASK

const outside = (grid: Screen, column: number, row: number): boolean => column < 0 || row < 0 || column >= grid.width || row >= grid.height
const spacer = (width: number): boolean => width === CellWidth.SpacerTail || width === CellWidth.SpacerHead

interface Interning<Value> {
  intern(value: Value): number
  get(slot: number): Value
}

export class CharPool implements Interning<string> {
  private glyphs: string[] = unbuilt('src/ink/cell-grid.ts:47')
  private slotOf: Map<string, number> = unbuilt('src/ink/cell-grid.ts:48')
  private asciiSlots: Unbuilt = unbuilt('src/ink/cell-grid.ts:49')

  intern(glyph: string): number {
    return notBuilt('src/ink/cell-grid.ts:51')
  }

  private rememberAscii(code: number, glyph: string): number {
    return notBuilt('src/ink/cell-grid.ts:59')
  }

  private remember(glyph: string): number {
    return notBuilt('src/ink/cell-grid.ts:66')
  }

  get(slot: number): string {
    return notBuilt('src/ink/cell-grid.ts:73')
  }

  size(): number {
    return notBuilt('src/ink/cell-grid.ts:77')
  }
}

export class HyperlinkPool implements Interning<string | undefined> {
  private links: string[] = ['']
  private slotOf = new Map<string, number>()

  intern(link: string | undefined): number {
    if (!link) return 0
    const known = this.slotOf.get(link)
    if (known !== undefined) return known
    const slot = this.slotOf.size + 1
    this.slotOf.set(link, slot)
    this.links[slot] = link
    return slot
  }

  get(slot: number): string | undefined {
    return slot === 0 ? undefined : this.links[slot]
  }
}

const FG_END = '\x1b[39m'
const BG_END = '\x1b[49m'
const INVERSE_END = '\x1b[27m'
const BOLD_END = '\x1b[22m'
const UNDERLINE_END = '\x1b[24m'
const MARKS_A_SPACE: ReadonlySet<string> = new Set([INVERSE_END, UNDERLINE_END, '\x1b[29m', '\x1b[55m'])
const VISIBLE_ON_SPACE: ReadonlySet<string> = new Set([BG_END, ...MARKS_A_SPACE])
const INVERSE_CODE: AnsiCode = { type: 'ansi', code: '\x1b[7m', endCode: INVERSE_END }
const BOLD_CODE: AnsiCode = { type: 'ansi', code: '\x1b[1m', endCode: BOLD_END }
const UNDERLINE_CODE: AnsiCode = { type: 'ansi', code: '\x1b[4m', endCode: UNDERLINE_END }
const MATCH_FG_CODE: AnsiCode = { type: 'ansi', code: '\x1b[33m', endCode: FG_END }
const EMPHASIS_CODES: ReadonlyArray<readonly [string, AnsiCode]> = [[INVERSE_END, INVERSE_CODE], [BOLD_END, BOLD_CODE], [UNDERLINE_END, UNDERLINE_CODE]]
const PAIR_KEY_SPAN = 0x100000

const dropEnds = (codes: readonly AnsiCode[], ...ends: string[]): AnsiCode[] => codes.filter(code => !ends.includes(code.endCode))
const carriesEnd = (codes: readonly AnsiCode[], end: string): boolean => codes.some(code => code.endCode === end)

const currentMatchCodes = (base: readonly AnsiCode[]): AnsiCode[] => [
  ...dropEnds(base, FG_END, BG_END),
  MATCH_FG_CODE,
  ...EMPHASIS_CODES.filter(([end]) => !carriesEnd(base, end)).map(([, code]) => code),
]

const rememberPair = (cache: Map<number, string>, from: number, to: number, serialise: (from: number, to: number) => string): string => {
  const key = from * PAIR_KEY_SPAN + to
  const known = cache.get(key)
  if (known !== undefined) return known
  const bytes = serialise(from, to)
  cache.set(key, bytes)
  return bytes
}

export class StylePool implements Interning<AnsiCode[]> {
  private idOfKey: Map<string, number> = unbuilt('src/ink/cell-grid.ts:134')
  private styles: Array<AnsiCode[]> = unbuilt('src/ink/cell-grid.ts:135')
  private transitions: Map<number, string> = unbuilt('src/ink/cell-grid.ts:136')
  readonly none: Unbuilt = unbuilt('src/ink/cell-grid.ts:137')
  private inverseOf: Map<number, number> = unbuilt('src/ink/cell-grid.ts:138')
  private currentMatchOf: Map<number, number> = unbuilt('src/ink/cell-grid.ts:139')
  private selectionGround: AnsiCode | null = unbuilt('src/ink/cell-grid.ts:140')
  private selectionBgOf: Map<number, number> = unbuilt('src/ink/cell-grid.ts:141')
  private recessCfg: RecessTransform | null = unbuilt('src/ink/cell-grid.ts:142')
  private recessCfgKey: string = unbuilt('src/ink/cell-grid.ts:143')
  private recessOf: Map<number, number> = unbuilt('src/ink/cell-grid.ts:144')
  private recessIds: Set<number> = unbuilt('src/ink/cell-grid.ts:145')
  private recessBudgetWarned: boolean = unbuilt('src/ink/cell-grid.ts:146')

  intern(codes: AnsiCode[]): number {
    return notBuilt('src/ink/cell-grid.ts:148')
  }

  get(styleId: number): AnsiCode[] {
    const codes = this.styles[styleId >>> 1]
    return codes === undefined ? [] : codes
  }

  marksSpace(styleId: number): boolean {
    return (styleId & 1) === 1 && this.get(styleId).some(code => MARKS_A_SPACE.has(code.endCode))
  }

  private readonly serialiseTransition = (fromId: number, toId: number): string => ansiCodesToString(diffAnsiCodes(this.get(fromId), this.get(toId)))

  transition(from: number, to: number): string {
    return from === to ? '' : rememberPair(this.transitions, from, to, this.serialiseTransition)
  }

  private derive(cache: Map<number, number>, baseId: number, build: (base: AnsiCode[]) => number): number {
    const known = cache.get(baseId)
    if (known !== undefined) return known
    const derived = build(this.get(baseId))
    cache.set(baseId, derived)
    return derived
  }

  private readonly buildInverse = (base: AnsiCode[]): number => this.intern([...base, INVERSE_CODE])
  withInverse(styleId: number): number {
    return this.derive(this.inverseOf, styleId, base => (carriesEnd(base, INVERSE_END) ? styleId : this.buildInverse(base)))
  }

  private readonly buildCurrentMatch = (base: AnsiCode[]): number => this.intern(currentMatchCodes(base))
  withCurrentMatch(styleId: number): number {
    return this.derive(this.currentMatchOf, styleId, this.buildCurrentMatch)
  }

  setSelectionBg(code: AnsiCode | null): void {
    const held = this.selectionGround?.code ?? null
    if (held === (code?.code ?? null)) return
    this.selectionGround = code
    this.selectionBgOf.clear()
  }

  private readonly buildSelectionBg = (base: AnsiCode[]): number => this.intern([...dropEnds(base, BG_END, INVERSE_END), this.selectionGround!])
  withSelectionBg(styleId: number): number {
    return this.selectionGround === null ? this.withInverse(styleId) : this.derive(this.selectionBgOf, styleId, this.buildSelectionBg)
  }

  setRecessTransform(cfg: RecessTransform | null): void {
    const key = cfg ? `${cfg.canvas.join(',')}|${cfg.ink.join(',')}|${cfg.quantize256 ? 1 : 0}` : ''
    if (key === this.recessCfgKey) return
    this.recessCfgKey = key
    this.recessCfg = cfg
    this.recessOf.clear()
    this.recessIds.clear()
  }

  private recessed(base: AnsiCode[], cfg: RecessTransform): number {
    const codes: AnsiCode[] = []
    let inked = false
    for (const code of base) {
      if (code.endCode === FG_END) inked = true
      codes.push(code.endCode === FG_END ? recessColorCode(code, 38, cfg) : code.endCode === BG_END ? recessColorCode(code, 48, cfg) : code)
    }
    if (!inked) codes.push(colorCode(38, mixToward(cfg.ink, cfg.canvas, RECESS_MIX), cfg.quantize256))
    const recessedId = this.intern(codes)
    this.recessIds.add(recessedId)
    return recessedId
  }

  withRecess(baseId: number): number {
    const cfg = this.recessCfg
    if (cfg === null || this.recessIds.has(baseId)) return baseId
    if (this.styles.length >= 16000) {
      if (!this.recessBudgetWarned) {
        this.recessBudgetWarned = true
        warn.once('style-pool near capacity — recess derivation degraded to identity')
      }
      return baseId
    }
    return this.derive(this.recessOf, baseId, base => this.recessed(base, cfg))
  }
}

export type RecessTransform = { canvas: readonly [number, number, number]; ink: readonly [number, number, number]; quantize256: boolean }

export const RECESS_MIX = 0.5

type Rgb = [number, number, number]

export function mixToward(from: readonly [number, number, number], to: readonly [number, number, number], t: number): Rgb {
  const blend = (channel: 0 | 1 | 2): number => Math.round(from[channel] + (to[channel] - from[channel]) * t)
  return [blend(0), blend(1), blend(2)]
}

const cubeLevel = (v: number): number => (v === 0 ? 0 : 55 + v * 40)

const cubeRgb = (i: number): Rgb => [cubeLevel(Math.floor(i / 36)), cubeLevel(Math.floor((i % 36) / 6)), cubeLevel(i % 6)]

const grayRgb = (n: number): Rgb => {
  const v = 8 + 10 * (n - 232)
  return [v, v, v]
}

export function xterm256ToRgb(n: number): Rgb | null {
  return n < 16 ? null : n <= 231 ? cubeRgb(n - 16) : n <= 255 ? grayRgb(n) : null
}

export function rgbToXterm256(r: number, g: number, b: number): number {
  const level = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)))
  const cube = [level(r), level(g), level(b)]
  const nearestCube = [cubeLevel(cube[0]!), cubeLevel(cube[1]!), cubeLevel(cube[2]!)]
  const gray = Math.max(0, Math.min(23, Math.round((0.299 * r + 0.587 * g + 0.114 * b - 8) / 10)))
  const gv = 8 + 10 * gray
  const distance = (a: number[], x: number, y: number, z: number): number => (a[0]! - x) ** 2 + (a[1]! - y) ** 2 + (a[2]! - z) ** 2
  return distance(nearestCube, r, g, b) <= distance([gv, gv, gv], r, g, b) ? 16 + 36 * cube[0]! + 6 * cube[1]! + cube[2]! : 232 + gray
}

type ColorChannel = 38 | 48

const colorCode = (channel: ColorChannel, [r, g, b]: Rgb, quantize256: boolean): AnsiCode => {
  const code = quantize256 ? `\x1b[${channel};5;${rgbToXterm256(r, g, b)}m` : `\x1b[${channel};2;${r};${g};${b}m`
  return { type: 'ansi', code, endCode: channel === 38 ? FG_END : BG_END }
}

const TRUECOLOR_FORM: Record<ColorChannel, RegExp> = { 38: /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/, 48: /^\x1b\[48;2;(\d+);(\d+);(\d+)m$/ }
const INDEXED_FORM: Record<ColorChannel, RegExp> = { 38: /^\x1b\[38;5;(\d+)m$/, 48: /^\x1b\[48;5;(\d+)m$/ }

function recessColorCode(code: AnsiCode, channel: ColorChannel, cfg: RecessTransform): AnsiCode {
  const truecolor = TRUECOLOR_FORM[channel].exec(code.code)
  if (truecolor) return colorCode(channel, mixToward([Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])], cfg.canvas, RECESS_MIX), cfg.quantize256)
  const indexed = INDEXED_FORM[channel].exec(code.code)
  const rgb = indexed ? xterm256ToRgb(Number(indexed[1])) : null
  return rgb === null ? code : colorCode(channel, mixToward(rgb, cfg.canvas, RECESS_MIX), true)
}

export function remapStylesOutside(grid: Screen, rects: readonly Rectangle[], remap: (styleId: number) => number): number {
  const words = grid.cells
  let restyled = 0
  let boxLeft = 0
  let boxTop = 0
  let boxRight = 0
  let boxBottom = 0
  for (let row = 0; row < grid.height; row++) {
    for (let column = 0; column < grid.width; column++) {
      if (rects.some(rect => column >= rect.x && column < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height)) continue
      const at = (row * grid.width + column) << 1
      const word = words[at + 1]!
      if (words[at] === 0 && word === 0) continue
      const width = word & WIDTH_BITS
      if (spacer(width)) continue
      const styleId = word >>> STYLE_OFFSET
      const next = remap(styleId)
      if (next === styleId) continue
      words[at + 1] = packWord(next, linkOf(word), width)
      if (restyled === 0) {
        boxLeft = column
        boxTop = row
        boxRight = column + 1
        boxBottom = row + 1
      } else {
        if (column < boxLeft) boxLeft = column
        if (column + 1 > boxRight) boxRight = column + 1
        if (row < boxTop) boxTop = row
        if (row + 1 > boxBottom) boxBottom = row + 1
      }
      restyled++
    }
  }
  if (restyled > 0) touch(grid, boxLeft, boxTop, boxRight, boxBottom)
  return restyled
}

const wholeCells = (count: number, label: string): number => {
  warn.ifNotInteger(count, label)
  return Number.isInteger(count) && count >= 0 ? count : Math.max(0, Math.floor(count) || 0)
}

function cellPlanes(cellCount: number): CellPlanes {
  const bytes = new ArrayBuffer(cellCount << 3)
  return { cells: new Int32Array(bytes), cells64: new BigInt64Array(bytes), noSelect: new Uint8Array(cellCount) }
}

export function createScreen(width: number, height: number, styles: StylePool, charPool: CharPool, hyperlinkPool: HyperlinkPool): Screen {
  const columns = wholeCells(width, 'createScreen width')
  const rows = wholeCells(height, 'createScreen height')
  const grid: Screen = { width: columns, height: rows, ...cellPlanes(columns * rows), charPool, hyperlinkPool, emptyStyleId: styles.none, damage: undefined, softWrap: new Int32Array(rows) }
  return grid
}

export function resetScreen(grid: Screen, width: number, height: number): void {
  return notBuilt('src/ink/cell-grid.ts:347')
}

export function migrateScreenPools(grid: Screen, charPool: CharPool, hyperlinkPool: HyperlinkPool): void {
  return notBuilt('src/ink/cell-grid.ts:361')
}

function touch(grid: Screen, left: number, top: number, right: number, bottom: number): void {
  if (right <= left || bottom <= top) return
  const box = grid.damage
  if (box === undefined) {
    grid.damage = { x: left, y: top, width: right - left, height: bottom - top }
  } else {
    const boxLeft = box.x < left ? box.x : left
    const boxTop = box.y < top ? box.y : top
    const boxRight = box.x + box.width > right ? box.x + box.width : right
    const boxBottom = box.y + box.height > bottom ? box.y + box.height : bottom
    box.x = boxLeft
    box.y = boxTop
    box.width = boxRight - boxLeft
    box.height = boxBottom - boxTop
  }
}

const decodeWords = (glyphs: CharPool, links: HyperlinkPool, glyphId: number, word: number): Cell => {
  const linkId = linkOf(word)
  return { char: glyphs.get(glyphId), styleId: word >>> STYLE_OFFSET, width: word & WIDTH_BITS, hyperlink: linkId === 0 ? undefined : links.get(linkId) }
}

export function cellAt(grid: Screen, column: number, row: number): Cell | undefined {
  return outside(grid, column, row) ? undefined : cellAtIndex(grid, row * grid.width + column)
}

export function cellAtIndex(grid: Screen, index: number): Cell {
  const at = index << 1
  return decodeWords(grid.charPool, grid.hyperlinkPool, grid.cells[at]!, grid.cells[at + 1]!)
}

const paintsNothing = (glyphId: number, word: number, lastRenderedStyleId: number): boolean => {
  if (glyphId === SPACER_GLYPH) return true
  if (glyphId !== BLANK_GLYPH || (word & SPACE_VISIBLE_MASK) !== 0) return false
  const styleId = word >>> STYLE_OFFSET
  return styleId === 0 || styleId === lastRenderedStyleId
}

export function visibleCellAtIndex(cells: Int32Array, charPool: CharPool, hyperlinkPool: HyperlinkPool, index: number, lastRenderedStyleId: number): Cell | undefined {
  const at = index << 1
  const glyphId = cells[at]!
  const word = cells[at + 1]!
  return paintsNothing(glyphId, word, lastRenderedStyleId) ? undefined : decodeWords(charPool, hyperlinkPool, glyphId, word)
}

function decodeInto(grid: Screen, at: number, view: Cell): void {
  const word = grid.cells[at + 1]!
  const linkId = linkOf(word)
  view.char = grid.charPool.get(grid.cells[at]!)
  view.styleId = word >>> STYLE_OFFSET
  view.width = word & WIDTH_BITS
  view.hyperlink = linkId === 0 ? undefined : grid.hyperlinkPool.get(linkId)
}

export function charInCellAt(grid: Screen, column: number, row: number): string | undefined {
  return outside(grid, column, row) ? undefined : grid.charPool.get(grid.cells[(row * grid.width + column) << 1]!)
}

const emptyAt = (grid: Screen, index: number): boolean => grid.cells[index << 1] === 0 && grid.cells[(index << 1) + 1] === 0

export function isEmptyCellAt(grid: Screen, column: number, row: number): boolean {
  return outside(grid, column, row) || emptyAt(grid, row * grid.width + column)
}

function inklessAt(grid: Screen, index: number, styles: StylePool): boolean {
  const word = grid.cells[(index << 1) + 1]!
  return grid.cells[index << 1] === BLANK_GLYPH && (word & WIDTH_BITS) === CellWidth.Narrow && linkOf(word) === 0 && !styles.marksSpace(word >>> STYLE_OFFSET)
}

export function isInklessCellAt(grid: Screen, column: number, row: number, styles: StylePool): boolean {
  return outside(grid, column, row) || inklessAt(grid, row * grid.width + column, styles)
}

export function inkFlanksCellAt(grid: Screen, column: number, row: number, left: number, right: number, styles: StylePool): boolean {
  if (outside(grid, column, row)) return false
  const rowStart = row * grid.width
  const from = Math.max(0, left)
  const to = Math.min(grid.width, right)
  let before = column - 1
  while (before >= from && inklessAt(grid, rowStart + before, styles)) before--
  if (before < from) return false
  let after = column + 1
  while (after < to && inklessAt(grid, rowStart + after, styles)) after++
  return after < to
}

function blankCell(grid: Screen, at: number): void {
  grid.cells[at] = BLANK_GLYPH
  grid.cells[at + 1] = packWord(grid.emptyStyleId, 0, CellWidth.Narrow)
}

function mendWidePairs(grid: Screen, column: number, row: number, incomingWidth: CellWidth): number {
  const words = grid.cells
  const at = (row * grid.width + column) << 1
  const standingWidth = words[at + 1]! & WIDTH_BITS
  const tailAhead = column + 1 < grid.width
  let leftmostMended = column
  if (standingWidth === CellWidth.Wide && incomingWidth !== CellWidth.Wide && tailAhead && (words[at + 3]! & WIDTH_BITS) === CellWidth.SpacerTail) {
    blankCell(grid, at + 2)
    touch(grid, column + 1, row, column + 2, row + 1)
  }
  if (standingWidth === CellWidth.SpacerTail && incomingWidth !== CellWidth.SpacerTail && column > 0 && (words[at - 1]! & WIDTH_BITS) === CellWidth.Wide) {
    blankCell(grid, at - 2)
    leftmostMended = column - 1
  }
  if (incomingWidth === CellWidth.Wide && tailAhead && (words[at + 3]! & WIDTH_BITS) === CellWidth.Wide && column + 2 < grid.width && (words[at + 5]! & WIDTH_BITS) === CellWidth.SpacerTail) {
    blankCell(grid, at + 4)
    touch(grid, column + 2, row, column + 3, row + 1)
  }
  return leftmostMended
}

export function setCellAt(grid: Screen, column: number, row: number, cell: Cell): void {
  if (outside(grid, column, row)) return
  const words = grid.cells
  const at = (row * grid.width + column) << 1
  const leftmostMended = mendWidePairs(grid, column, row, cell.width)
  words[at] = grid.charPool.intern(cell.char)
  words[at + 1] = packWord(cell.styleId, grid.hyperlinkPool.intern(cell.hyperlink), cell.width)
  const tailWritten = cell.width === CellWidth.Wide && column + 1 < grid.width
  if (tailWritten) {
    words[at + 2] = SPACER_GLYPH
    words[at + 3] = packWord(grid.emptyStyleId, 0, CellWidth.SpacerTail)
  }
  touch(grid, leftmostMended, row, tailWritten ? column + 2 : column + 1, row + 1)
}

export function setCellStyleId(grid: Screen, column: number, row: number, styleId: number): void {
  return notBuilt('src/ink/cell-grid.ts:504')
}

export function blitRegion(into: Screen, from: Screen, regionX: number, regionY: number, maxX: number, maxY: number): void {
  return notBuilt('src/ink/cell-grid.ts:514')
}

const packedBlankBuffer = new ArrayBuffer(8)
const packedBlankWords = new Int32Array(packedBlankBuffer)
const packedBlankCell64 = new BigInt64Array(packedBlankBuffer)

function blankCell64ForStyle(styleId: number): bigint {
  if (styleId === 0) return EMPTY_CELL
  packedBlankWords[0] = BLANK_GLYPH
  packedBlankWords[1] = packWord(styleId, 0, CellWidth.Narrow)
  return packedBlankCell64[0]!
}

export function fillRegion(grid: Screen, regionX: number, regionY: number, regionWidth: number, regionHeight: number, styleId: number): void {
  const left = Math.max(0, regionX)
  const top = Math.max(0, regionY)
  const right = Math.min(regionX + regionWidth, grid.width)
  const bottom = Math.min(regionY + regionHeight, grid.height)
  if (left >= right || top >= bottom) return
  const cell64 = blankCell64ForStyle(styleId)
  const words = grid.cells
  const columns = grid.width
  let touchedLeft = left
  let touchedRight = right
  if (left === 0 && right === columns) {
    grid.cells64.fill(cell64, top * columns, bottom * columns)
  } else {
    for (let row = top; row < bottom; row++) {
      const rowStart = row * columns
      const leftWord = (rowStart + left) << 1
      if (left > 0 && (words[leftWord + 1]! & WIDTH_BITS) === CellWidth.SpacerTail && (words[leftWord - 1]! & WIDTH_BITS) === CellWidth.Wide) {
        blankCell(grid, leftWord - 2)
        touchedLeft = left - 1
      }
      const lastWord = (rowStart + right - 1) << 1
      if (right < columns && (words[lastWord + 1]! & WIDTH_BITS) === CellWidth.Wide && (words[lastWord + 3]! & WIDTH_BITS) === CellWidth.SpacerTail) {
        blankCell(grid, lastWord + 2)
        touchedRight = right + 1
      }
      grid.cells64.fill(cell64, rowStart + left, rowStart + right)
    }
  }
  touch(grid, touchedLeft, top, touchedRight, bottom)
}

export function clearRegion(grid: Screen, regionX: number, regionY: number, regionWidth: number, regionHeight: number): void {
  fillRegion(grid, regionX, regionY, regionWidth, regionHeight, 0)
}

export function shiftRows(grid: Screen, top: number, bottom: number, n: number): void {
  if (n === 0 || top < 0 || bottom >= grid.height || top > bottom) return
  const columns = grid.width
  const { cells64, noSelect, softWrap } = grid
  const vacate = (fromRow: number, toRow: number): void => {
    cells64.fill(EMPTY_CELL, fromRow * columns, toRow * columns)
    noSelect.fill(0, fromRow * columns, toRow * columns)
    softWrap.fill(0, fromRow, toRow)
  }
  const carry = (toRow: number, fromRow: number, endRow: number): void => {
    cells64.copyWithin(toRow * columns, fromRow * columns, endRow * columns)
    noSelect.copyWithin(toRow * columns, fromRow * columns, endRow * columns)
    softWrap.copyWithin(toRow, fromRow, endRow)
  }
  if (Math.abs(n) > bottom - top) {
    vacate(top, bottom + 1)
  } else if (n > 0) {
    carry(top, top + n, bottom + 1)
    vacate(bottom - n + 1, bottom + 1)
  } else {
    carry(top - n, top, bottom + n + 1)
    vacate(top, top - n)
  }
}

export function shiftRect(grid: Screen, top: number, bottom: number, x0: number, x1: number, n: number): void {
  if (n === 0 || top < 0 || bottom >= grid.height || top > bottom) return
  const columns = grid.width
  const left = Math.max(0, Math.floor(x0))
  const right = Math.min(columns, Math.floor(x1))
  if (right <= left) return
  const { cells64, noSelect, softWrap } = grid
  const vacateRow = (row: number): void => {
    cells64.fill(EMPTY_CELL, row * columns + left, row * columns + right)
    noSelect.fill(0, row * columns + left, row * columns + right)
  }
  const carryRow = (row: number): void => {
    cells64.copyWithin(row * columns + left, (row + n) * columns + left, (row + n) * columns + right)
    noSelect.copyWithin(row * columns + left, (row + n) * columns + left, (row + n) * columns + right)
  }
  if (Math.abs(n) > bottom - top) {
    for (let row = top; row <= bottom; row++) vacateRow(row)
  } else if (n > 0) {
    for (let row = top; row <= bottom - n; row++) carryRow(row)
    for (let row = bottom - n + 1; row <= bottom; row++) vacateRow(row)
  } else {
    for (let row = bottom; row >= top - n; row--) carryRow(row)
    for (let row = top; row < top - n; row++) vacateRow(row)
  }
  softWrap.fill(0, top, bottom + 1)
}

export function markNoSelectRegion(grid: Screen, x: number, y: number, width: number, height: number): void {
  const right = Math.min(x + width, grid.width)
  const bottom = Math.min(y + height, grid.height)
  const left = Math.max(0, x)
  for (let row = Math.max(0, y); row < bottom; row++) grid.noSelect.fill(1, row * grid.width + left, row * grid.width + right)
}

const OSC8_FORM = new RegExp(`^${ESC}\\]8${SEP}${SEP}([^${BEL}]*)${BEL}$`)
export const OSC8_PREFIX = ESC + ']8' + SEP

const linkCode = (style: AnsiCode): boolean => style.code.startsWith(OSC8_PREFIX) && OSC8_FORM.test(style.code)

export function extractHyperlinkFromStyles(codes: AnsiCode[]): Hyperlink | null {
  const link = codes.find(style => style.code.length >= 5 && linkCode(style))
  return link === undefined ? null : OSC8_FORM.exec(link.code)![1] || null
}

export function filterOutHyperlinkStyles(codes: AnsiCode[]): AnsiCode[] {
  return codes.filter(style => !linkCode(style))
}

type DiffCallback = (x: number, y: number, removed: Cell | undefined, added: Cell | undefined) => boolean | void

type DiffRow = [point: Point, removed: Cell | undefined, added: Cell | undefined]

export function diff(prev: Screen, next: Screen): DiffRow[] {
  const rows: DiffRow[] = []
  diffEach(prev, next, (column, row, removed, added) => {
    rows.push([{ x: column, y: row }, removed ? { ...removed } : undefined, added ? { ...added } : undefined])
  })
  return rows
}

const freshView = (): Cell => ({ char: ' ', styleId: 0, width: CellWidth.Narrow, hyperlink: undefined })

function walkRegion(prev: Screen, next: Screen, fromRow: number): Rectangle {
  const width = Math.max(prev.width, next.width)
  const height = Math.max(prev.height, next.height)
  const top = Math.min(Math.max(0, Math.floor(fromRow)), height)
  return { x: 0, y: top, width, height: height - top }
}

export function diffEach(prev: Screen, next: Screen, cb: DiffCallback, fromRow = 0): boolean {
  const region = walkRegion(prev, next, fromRow)
  const endY = Math.min(region.y + region.height, Math.max(prev.height, next.height))
  const endX = Math.min(region.x + region.width, Math.max(prev.width, next.width))
  const removedView = freshView()
  const addedView = freshView()
  const walk = prev.width === next.width ? walkSameWidth : walkResize
  return walk(prev, next, region.x, endX, region.y, endY, removedView, addedView, cb)
}

function walkSameWidth(prev: Screen, next: Screen, left: number, right: number, top: number, bottom: number, removedView: Cell, addedView: Cell, cb: DiffCallback): boolean {
  return notBuilt('src/ink/cell-grid.ts:746')
}

function walkResize(prev: Screen, next: Screen, left: number, right: number, top: number, bottom: number, removedView: Cell, addedView: Cell, cb: DiffCallback): boolean {
  return notBuilt('src/ink/cell-grid.ts:796')
}
