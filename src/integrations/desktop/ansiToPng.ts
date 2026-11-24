import { deflateSync } from 'node:zlib'

import { pngChunk } from '../../platform/images/imageProcessorJs.js'
import { stringWidth } from '../../screen/renderer/stringWidth.js'
import { DEFAULT_BG, parseAnsi, type AnsiColor, type ParsedLine } from './ansiSpans.js'


const CELL_WIDTH = 24
const CELL_HEIGHT = 48
const CELL_BYTES = CELL_WIDTH * CELL_HEIGHT


type StrokeGlyph = number[][]

const STROKE_GLYPHS: Record<string, StrokeGlyph> = {
  ' ': [],
  '!': [[3, 0, 3, 6], [3, 8.6, 3, 9]],
  '"': [[2, 0, 2, 2], [4, 0, 4, 2]],
  '#': [[2.2, 0.5, 1.6, 8.5], [4.4, 0.5, 3.8, 8.5], [1, 3, 5.2, 3], [0.8, 6, 5, 6]],
  $: [
    [5, 1.6, 4, 0.8, 2, 0.8, 1, 1.8, 1, 3, 2, 4, 4, 5, 5, 6, 5, 7.4, 4, 8.4, 2, 8.4, 1, 7.6],
    [3, 0, 3, 9.4],
  ],
  '%': [
    [5, 0, 1, 9],
    [1, 0.4, 2.2, 0.4, 2.2, 2.4, 1, 2.4, 1, 0.4],
    [3.8, 6.6, 5, 6.6, 5, 8.8, 3.8, 8.8, 3.8, 6.6],
  ],
  '&': [[5, 9, 1.6, 4.6, 1.2, 3, 1.6, 1, 3, 0.4, 4, 1.2, 4, 2.6, 1, 6, 1, 7.8, 2.2, 9, 3.6, 8.6, 5, 6.4]],
  "'": [[3, 0, 3, 2]],
  '(': [[4, 0, 2.8, 2, 2.8, 7, 4, 9]],
  ')': [[2, 0, 3.2, 2, 3.2, 7, 2, 9]],
  '*': [[3, 1.5, 3, 6.5], [1, 2.4, 5, 5.6], [5, 2.4, 1, 5.6]],
  '+': [[3, 2.5, 3, 7.5], [0.9, 5, 5.1, 5]],
  ',': [[3, 8.5, 3, 9.3, 2.3, 10.6]],
  '-': [[1.5, 5, 4.5, 5]],
  '.': [[3, 8.6, 3, 9]],
  '/': [[5, 0, 1, 9]],
  '0': [[1, 1, 2, 0, 4, 0, 5, 1, 5, 8, 4, 9, 2, 9, 1, 8, 1, 1]],
  '1': [[2, 1.6, 3.4, 0, 3.4, 9], [1.6, 9, 5, 9]],
  '2': [[1, 1.6, 2, 0, 4, 0, 5, 1, 5, 3, 1, 9], [1, 9, 5, 9]],
  '3': [[1, 1, 2, 0, 4, 0, 5, 1, 5, 3, 4, 4, 5, 5, 5, 8, 4, 9, 2, 9, 1, 8], [2.6, 4, 4, 4]],
  '4': [[4, 0, 1, 6, 5, 6], [4, 0, 4, 9]],
  '5': [[5, 0, 1, 0, 1, 4, 4, 4, 5, 5, 5, 8, 4, 9, 2, 9, 1, 8]],
  '6': [[5, 1, 4, 0, 2, 0, 1, 1, 1, 8, 2, 9, 4, 9, 5, 8, 5, 5, 4, 4, 1, 4]],
  '7': [[1, 0, 5, 0, 2, 9]],
  '8': [
    [2, 0, 4, 0, 5, 1, 5, 3, 4, 4, 2, 4, 1, 3, 1, 1, 2, 0],
    [2, 4, 1, 5, 1, 8, 2, 9, 4, 9, 5, 8, 5, 5, 4, 4],
  ],
  '9': [[5, 4, 2, 4, 1, 3, 1, 1, 2, 0, 4, 0, 5, 1, 5, 8, 4, 9, 2, 9, 1, 8]],
  ':': [[3, 3.8, 3, 4.2], [3, 8.6, 3, 9]],
  ';': [[3, 3.8, 3, 4.2], [3, 8.5, 3, 9.3, 2.3, 10.6]],
  '<': [[4.5, 1.5, 1.2, 5, 4.5, 8.5]],
  '=': [[1.5, 3.8, 4.5, 3.8], [1.5, 6.2, 4.5, 6.2]],
  '>': [[1.5, 1.5, 4.8, 5, 1.5, 8.5]],
  '?': [[1, 1.6, 2, 0, 4, 0, 5, 1, 5, 2.8, 3, 4.4, 3, 6], [3, 8.6, 3, 9]],
  '@': [
    [
      5.2, 8.2, 3.6, 9, 2, 8.6, 1, 7.2, 0.8, 4.4, 1.6, 1.8, 3.4, 0.8, 5, 1.6, 5.6, 3.8, 5.6, 6.4,
      4.8, 6.8, 4, 6.2, 4, 4.4, 4.6, 3.8, 5.6, 4.2,
    ],
  ],
  A: [[1, 9, 3, 0, 5, 9], [1.8, 6, 4.2, 6]],
  B: [[1, 0, 1, 9], [1, 0, 4, 0, 5, 1, 5, 3, 4, 4, 1, 4], [4, 4, 5, 5, 5, 8, 4, 9, 1, 9]],
  C: [[5, 1, 4, 0, 2, 0, 1, 1, 1, 8, 2, 9, 4, 9, 5, 8]],
  D: [[1, 0, 1, 9], [1, 0, 3.4, 0, 5, 1.6, 5, 7.4, 3.4, 9, 1, 9]],
  E: [[5, 0, 1, 0, 1, 9, 5, 9], [1, 4.4, 4, 4.4]],
  F: [[5, 0, 1, 0, 1, 9], [1, 4.4, 4, 4.4]],
  G: [[5, 1, 4, 0, 2, 0, 1, 1, 1, 8, 2, 9, 4, 9, 5, 8, 5, 5, 3.2, 5]],
  H: [[1, 0, 1, 9], [5, 0, 5, 9], [1, 4.4, 5, 4.4]],
  I: [[2, 0, 4, 0], [3, 0, 3, 9], [2, 9, 4, 9]],
  J: [[5, 0, 5, 8, 4, 9, 2, 9, 1, 8]],
  K: [[1, 0, 1, 9], [5, 0, 1, 5], [2.4, 3.6, 5, 9]],
  L: [[1, 0, 1, 9, 5, 9]],
  M: [[1, 9, 1, 0, 3, 4.6, 5, 0, 5, 9]],
  N: [[1, 9, 1, 0, 5, 9, 5, 0]],
  O: [[1, 1, 2, 0, 4, 0, 5, 1, 5, 8, 4, 9, 2, 9, 1, 8, 1, 1]],
  P: [[1, 9, 1, 0, 4, 0, 5, 1, 5, 3.4, 4, 4.4, 1, 4.4]],
  Q: [[1, 1, 2, 0, 4, 0, 5, 1, 5, 8, 4, 9, 2, 9, 1, 8, 1, 1], [3.4, 6.8, 5.4, 9.6]],
  R: [[1, 9, 1, 0, 4, 0, 5, 1, 5, 3.4, 4, 4.4, 1, 4.4], [2.6, 4.4, 5, 9]],
  S: [[5, 1, 4, 0, 2, 0, 1, 1, 1, 3, 2, 4, 4, 5, 5, 6, 5, 8, 4, 9, 2, 9, 1, 8]],
  T: [[1, 0, 5, 0], [3, 0, 3, 9]],
  U: [[1, 0, 1, 8, 2, 9, 4, 9, 5, 8, 5, 0]],
  V: [[1, 0, 3, 9, 5, 0]],
  W: [[1, 0, 1.8, 9, 3, 4.4, 4.2, 9, 5, 0]],
  X: [[1, 0, 5, 9], [5, 0, 1, 9]],
  Y: [[1, 0, 3, 4.4, 5, 0], [3, 4.4, 3, 9]],
  Z: [[1, 0, 5, 0, 1, 9, 5, 9]],
  '[': [[4, 0, 2.5, 0, 2.5, 9.6, 4, 9.6]],
  '\\': [[1, 0, 5, 9]],
  ']': [[2, 0, 3.5, 0, 3.5, 9.6, 2, 9.6]],
  '^': [[1.6, 2.4, 3, 0.4, 4.4, 2.4]],
  _: [[0.6, 9.8, 5.4, 9.8]],
  '`': [[2.4, 0, 3.6, 1.6]],
  a: [[1.6, 3.2, 4, 3.2, 5, 4.2, 5, 9], [5, 6, 2, 6, 1, 7, 1, 8, 2, 9, 5, 9]],
  b: [[1, 0, 1, 9], [1, 4.2, 2, 3.2, 4, 3.2, 5, 4.2, 5, 8, 4, 9, 2, 9, 1, 8]],
  c: [[5, 4.2, 4, 3.2, 2, 3.2, 1, 4.2, 1, 8, 2, 9, 4, 9, 5, 8]],
  d: [[5, 0, 5, 9], [5, 4.2, 4, 3.2, 2, 3.2, 1, 4.2, 1, 8, 2, 9, 4, 9, 5, 8]],
  e: [[1, 6.2, 5, 6.2, 5, 4.2, 4, 3.2, 2, 3.2, 1, 4.2, 1, 8, 2, 9, 4.6, 9]],
  f: [[4.6, 0.4, 3.2, 0.4, 2.6, 1.2, 2.6, 9], [1.2, 3.4, 4.4, 3.4]],
  g: [
    [5, 3.2, 5, 11, 4, 12, 2, 12, 1.2, 11.2],
    [5, 4.2, 4, 3.2, 2, 3.2, 1, 4.2, 1, 7.2, 2, 8.2, 4, 8.2, 5, 7.2],
  ],
  h: [[1, 0, 1, 9], [1, 4.2, 2, 3.2, 4, 3.2, 5, 4.2, 5, 9]],
  i: [[3, 3.2, 3, 9], [3, 1, 3, 1.4]],
  j: [[3.6, 3.2, 3.6, 11, 2.8, 12, 1.6, 11.4], [3.6, 1, 3.6, 1.4]],
  k: [[1, 0, 1, 9], [4.6, 3.2, 1, 6.6], [2.4, 5.4, 5, 9]],
  l: [[3, 0, 3, 9]],
  m: [[1, 3.2, 1, 9], [1, 4.2, 2, 3.2, 3, 4.2, 3, 9], [3, 4.2, 4, 3.2, 5, 4.2, 5, 9]],
  n: [[1, 3.2, 1, 9], [1, 4.2, 2, 3.2, 4, 3.2, 5, 4.2, 5, 9]],
  o: [[1, 4.2, 2, 3.2, 4, 3.2, 5, 4.2, 5, 8, 4, 9, 2, 9, 1, 8, 1, 4.2]],
  p: [[1, 3.2, 1, 12], [1, 4.2, 2, 3.2, 4, 3.2, 5, 4.2, 5, 8, 4, 9, 2, 9, 1, 8]],
  q: [[5, 3.2, 5, 12], [5, 4.2, 4, 3.2, 2, 3.2, 1, 4.2, 1, 8, 2, 9, 4, 9, 5, 8]],
  r: [[1.6, 3.2, 1.6, 9], [1.6, 4.6, 2.6, 3.2, 4.2, 3.2, 5, 4.2]],
  s: [[5, 4, 4, 3.2, 2, 3.2, 1.2, 4, 2, 5.4, 4, 6.2, 4.8, 7.2, 4, 9, 2, 9, 1.2, 8.2]],
  t: [[2.6, 0.6, 2.6, 8, 3.4, 9, 4.6, 8.6], [1, 3.2, 4.6, 3.2]],
  u: [[1, 3.2, 1, 8, 2, 9, 4, 9, 5, 8], [5, 3.2, 5, 9]],
  v: [[1, 3.2, 3, 9, 5, 3.2]],
  w: [[1, 3.2, 1.8, 9, 3, 5.2, 4.2, 9, 5, 3.2]],
  x: [[1, 3.2, 5, 9], [5, 3.2, 1, 9]],
  y: [[1, 3.2, 3, 8.2], [5, 3.2, 2.2, 11.2, 1.4, 12]],
  z: [[1, 3.2, 5, 3.2, 1, 9, 5, 9]],
  '{': [[4.2, 0, 3.2, 0.8, 3.2, 3.8, 2.2, 4.8, 3.2, 5.8, 3.2, 8.8, 4.2, 9.6]],
  '|': [[3, 0, 3, 10.4]],
  '}': [[1.8, 0, 2.8, 0.8, 2.8, 3.8, 3.8, 4.8, 2.8, 5.8, 2.8, 8.8, 1.8, 9.6]],
  '~': [[1, 5.6, 1.8, 4.8, 2.8, 5, 3.6, 5.6, 4.4, 5.8, 5.2, 5]],
  '·': [[3, 4.8, 3, 5.2]],
  '•': [[2.6, 4.6, 3.4, 4.6, 3.4, 5.4, 2.6, 5.4, 2.6, 4.6], [3, 4.6, 3, 5.4]],
  '…': [[1.1, 8.7, 1.1, 9], [3, 8.7, 3, 9], [4.9, 8.7, 4.9, 9]],
  '←': [[0.8, 5, 5.2, 5], [2.4, 2.8, 0.8, 5, 2.4, 7.2]],
  '↑': [[3, 1, 3, 9], [1.2, 3.2, 3, 1, 4.8, 3.2]],
  '→': [[0.8, 5, 5.2, 5], [3.6, 2.8, 5.2, 5, 3.6, 7.2]],
  '↓': [[3, 1, 3, 9], [1.2, 6.8, 3, 9, 4.8, 6.8]],
  '─': [[-0.8, 6, 6.8, 6]],
  '│': [[3, -2.2, 3, 14.2]],
  '✓': [[1.2, 5.4, 2.6, 8.2, 5.2, 1.4]],
  '✗': [[1.4, 2, 4.8, 8.2], [4.8, 2, 1.4, 8.2]],
}

const STROKE_RADIUS = 1.5
const SUBPIXEL_STEP = 0.3
const FONT_X_OFFSET = 2
const FONT_X_SCALE = 20 / 6
const FONT_Y_OFFSET = 6
const FONT_Y_SCALE = 3
const DEFAULT_PADDING = 48
const DEFAULT_RADIUS = 16
function stampSegment(
  bitmap: Uint8Array,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radius: number,
): void {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy)
  const steps = Math.max(1, Math.ceil(length / SUBPIXEL_STEP))
  const inner = radius - 0.5
  const outer = radius + 0.5
  const reach = Math.ceil(outer)
  for (let step = 0; step <= steps; step++) {
    const t = step / steps
    const sx = x1 + dx * t
    const sy = y1 + dy * t
    const minX = Math.max(0, Math.floor(sx - reach))
    const maxX = Math.min(CELL_WIDTH - 1, Math.ceil(sx + reach))
    const minY = Math.max(0, Math.floor(sy - reach))
    const maxY = Math.min(CELL_HEIGHT - 1, Math.ceil(sy + reach))
    for (let py = minY; py <= maxY; py++) {
      const rowOffset = py * CELL_WIDTH
      const dpy = py + 0.5 - sy
      for (let px = minX; px <= maxX; px++) {
        const dpx = px + 0.5 - sx
        const dist = Math.hypot(dpx, dpy)
        if (dist >= outer) continue
        const coverage = dist <= inner ? 255 : Math.round((outer - dist) * 255)
        const idx = rowOffset + px
        if (coverage > bitmap[idx]!) bitmap[idx] = coverage
      }
    }
  }
}

function rasterizeStrokes(polylines: StrokeGlyph): Uint8Array {
  const bitmap = new Uint8Array(CELL_BYTES)
  for (const line of polylines) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const x1 = FONT_X_OFFSET + line[i]! * FONT_X_SCALE
      const y1 = FONT_Y_OFFSET + line[i + 1]! * FONT_Y_SCALE
      const x2 = FONT_X_OFFSET + line[i + 2]! * FONT_X_SCALE
      const y2 = FONT_Y_OFFSET + line[i + 3]! * FONT_Y_SCALE
      stampSegment(bitmap, x1, y1, x2, y2, STROKE_RADIUS)
    }
  }
  return bitmap
}

let fontCache: Map<number, Uint8Array> | null = null

function getFont(): Map<number, Uint8Array> {
  if (!fontCache) {
    const rasterized: Array<[number, Uint8Array]> = Object.entries(STROKE_GLYPHS).map(
      ([char, strokes]) => [char.codePointAt(0) as number, rasterizeStrokes(strokes)],
    )
    fontCache = new Map(rasterized)
  }
  return fontCache
}

let fallbackGlyphCache: Uint8Array | null = null
const SHADE_BLEND: Record<string, number> = {
  '░': 0.25,
  '▒': 0.5,
  '▓': 0.75,
  '█': 1.0,
}

type AnsiToPngOptions = {
  background?: AnsiColor
  padding?: number
  paddingX?: number
  paddingY?: number
  radius?: number
  scale?: number
}

function isBlankLine(line: ParsedLine): boolean {
  return line.every(span => /^\s*$/.test(span.text))
}

function getFallbackGlyph(): Uint8Array {
  if (!fallbackGlyphCache) {
    fallbackGlyphCache = rasterizeStrokes([[1, 1, 5, 1, 5, 9, 1, 9, 1, 1]])
  }
  return fallbackGlyphCache
}

function encodeRgbaPng(pixels: Buffer, width: number, height: number): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc(height * (1 + stride))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride)
    raw[rowStart] = 0
    pixels.copy(raw, rowStart + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function isOutsideRoundedRect(x: number, y: number, width: number, height: number, radius: number): boolean {
  if (radius <= 0) return false
  const cx = x + 0.5
  const cy = y + 0.5
  const dx = cx < radius ? radius - cx : cx > width - radius ? cx - (width - radius) : 0
  const dy = cy < radius ? radius - cy : cy > height - radius ? cy - (height - radius) : 0
  return dx > 0 && dy > 0 && dx * dx + dy * dy > radius * radius
}

function sampleGlyph(glyph: Uint8Array, gx: number, gy: number, cellW: number, cellH: number, bold: boolean): number {
  if (cellW === CELL_WIDTH && cellH === CELL_HEIGHT) {
    const idx = gy * CELL_WIDTH + gx
    let a = glyph[idx]!
    if (bold && gx > 0) {
      const left = glyph[idx - 1]!
      if (left > a) a = left
    }
    return a
  }
  const x0 = Math.floor((gx * CELL_WIDTH) / cellW)
  const x1 = Math.max(x0 + 1, Math.ceil(((gx + 1) * CELL_WIDTH) / cellW))
  const y0 = Math.floor((gy * CELL_HEIGHT) / cellH)
  const y1 = Math.max(y0 + 1, Math.ceil(((gy + 1) * CELL_HEIGHT) / cellH))
  let sum = 0
  let count = 0
  for (let sy = y0; sy < y1 && sy < CELL_HEIGHT; sy++) {
    const row = sy * CELL_WIDTH
    for (let sx = x0; sx < x1 && sx < CELL_WIDTH; sx++) {
      let a = glyph[row + sx]!
      if (bold && sx > 0) {
        const left = glyph[row + sx - 1]!
        if (left > a) a = left
      }
      sum += a
      count++
    }
  }
  return count > 0 ? Math.round(sum / count) : 0
}

function blendCellShade(
  pixels: Buffer,
  imgWidth: number,
  originX: number,
  originY: number,
  cellW: number,
  cellH: number,
  color: AnsiColor,
  opacity: number,
): void {
  const alpha = Math.round(opacity * 255)
  const inv = 255 - alpha
  for (let dy = 0; dy < cellH; dy++) {
    const py = originY + dy
    for (let dx = 0; dx < cellW; dx++) {
      const idx = (py * imgWidth + originX + dx) * 4
      if (pixels[idx + 3] === 0) continue
      pixels[idx] = Math.round((color.r * alpha + pixels[idx]! * inv) / 255)
      pixels[idx + 1] = Math.round((color.g * alpha + pixels[idx + 1]! * inv) / 255)
      pixels[idx + 2] = Math.round((color.b * alpha + pixels[idx + 2]! * inv) / 255)
      pixels[idx + 3] = 255
    }
  }
}

function blendCellGlyph(
  pixels: Buffer,
  imgWidth: number,
  originX: number,
  originY: number,
  cellW: number,
  cellH: number,
  glyph: Uint8Array,
  color: AnsiColor,
  bold: boolean,
): void {
  for (let dy = 0; dy < cellH; dy++) {
    const py = originY + dy
    for (let dx = 0; dx < cellW; dx++) {
      const idx = (py * imgWidth + originX + dx) * 4
      if (pixels[idx + 3] === 0) continue
      const alpha = sampleGlyph(glyph, dx, dy, cellW, cellH, bold)
      if (alpha === 0) continue
      const inv = 255 - alpha
      pixels[idx] = Math.round((color.r * alpha + pixels[idx]! * inv) / 255)
      pixels[idx + 1] = Math.round((color.g * alpha + pixels[idx + 1]! * inv) / 255)
      pixels[idx + 2] = Math.round((color.b * alpha + pixels[idx + 2]! * inv) / 255)
      pixels[idx + 3] = 255
    }
  }
}

function measureLineColumns(line: ParsedLine): number {
  let cols = 0
  for (const span of line) {
    for (const ch of span.text) {
      if (ch === '\r') continue
      cols += Math.max(0, stringWidth(ch))
    }
  }
  return cols
}

export function ansiToPng(ansiText: string, options?: AnsiToPngOptions): Buffer {
  const scale = options?.scale ?? 1
  const cellW = Math.max(1, Math.round(CELL_WIDTH * scale))
  const cellH = Math.max(1, Math.round(CELL_HEIGHT * scale))
  const padX = Math.max(0, Math.round((options?.paddingX ?? options?.padding ?? DEFAULT_PADDING) * scale))
  const padY = Math.max(0, Math.round((options?.paddingY ?? options?.padding ?? DEFAULT_PADDING) * scale))
  const radius = Math.max(0, (options?.radius ?? DEFAULT_RADIUS) * scale)
  const bg = options?.background ?? DEFAULT_BG

  const lines = parseAnsi(ansiText.replace(/\r\n/g, '\n'))
  while (lines.length > 1 && isBlankLine(lines[lines.length - 1]!)) {
    lines.pop()
  }

  let maxCols = 1
  for (const line of lines) {
    const cols = measureLineColumns(line)
    if (cols > maxCols) maxCols = cols
  }

  const width = Math.max(1, maxCols * cellW + padX * 2)
  const height = Math.max(1, lines.length * cellH + padY * 2)
  const cornerRadius = Math.min(radius, width / 2, height / 2)
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isOutsideRoundedRect(x, y, width, height, cornerRadius)) continue
      const idx = (y * width + x) * 4
      pixels[idx] = bg.r
      pixels[idx + 1] = bg.g
      pixels[idx + 2] = bg.b
      pixels[idx + 3] = 255
    }
  }

  const font = getFont()
  const fallback = getFallbackGlyph()

  for (let row = 0; row < lines.length; row++) {
    const originY = padY + row * cellH
    let col = 0
    for (const span of lines[row]!) {
      for (const ch of span.text) {
        if (ch === '\r') continue
        const w = stringWidth(ch)
        if (w <= 0) continue
        const originX = padX + col * cellW
        const shade = SHADE_BLEND[ch]
        if (shade !== undefined) {
          blendCellShade(pixels, width, originX, originY, cellW * w, cellH, span.color, shade)
        } else if (ch !== ' ') {
          const cp = ch.codePointAt(0)
          const glyph = (cp !== undefined ? font.get(cp) : undefined) ?? fallback
          blendCellGlyph(pixels, width, originX, originY, cellW, cellH, glyph, span.color, span.bold)
        }
        col += w
      }
    }
  }

  return encodeRgbaPng(pixels, width, height)
}
