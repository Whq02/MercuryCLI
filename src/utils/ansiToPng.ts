import { deflateSync } from 'node:zlib'

import { stringWidth } from '../ink/stringWidth.js'
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
const STROKE_SCALE = 3.2
const STROKE_OFFSET_X = 2.4
const STROKE_OFFSET_Y = 4.8

function pointToSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function rasterizeStrokes(polylines: StrokeGlyph): Uint8Array {
  const bitmap = new Uint8Array(CELL_BYTES)
  if (polylines.length === 0) return bitmap
  const segments: Array<[number, number, number, number]> = []
  for (const line of polylines) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      segments.push([
        line[i]! * STROKE_SCALE + STROKE_OFFSET_X,
        line[i + 1]! * STROKE_SCALE + STROKE_OFFSET_Y,
        line[i + 2]! * STROKE_SCALE + STROKE_OFFSET_X,
        line[i + 3]! * STROKE_SCALE + STROKE_OFFSET_Y,
      ])
    }
  }
  if (segments.length === 0) return bitmap
  const inner = STROKE_RADIUS - 0.5
  const outer = STROKE_RADIUS + 0.5
  for (let py = 0; py < CELL_HEIGHT; py++) {
    const cy = py + 0.5
    const rowOffset = py * CELL_WIDTH
    for (let px = 0; px < CELL_WIDTH; px++) {
      const cx = px + 0.5
      let minDist = Infinity
      for (const [x1, y1, x2, y2] of segments) {
        const d = pointToSegmentDistance(cx, cy, x1, y1, x2, y2)
        if (d < minDist) minDist = d
      }
      if (minDist <= inner) bitmap[rowOffset + px] = 255
      else if (minDist < outer) bitmap[rowOffset + px] = Math.round((outer - minDist) * 255)
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 4, 'ascii')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)
  return chunk
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

function sampleGlyph(glyph: Uint8Array, gx: number, gy: number, cellW: number, cellH: number, bold: boolean): number {
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
      const alpha = sampleGlyph(glyph, dx, dy, cellW, cellH, bold)
      if (alpha === 0) continue
      const inv = 255 - alpha
      const idx = (py * imgWidth + originX + dx) * 4
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
  const scale = Math.max(1, options?.scale ?? 1)
  const cellW = Math.max(1, Math.round((CELL_WIDTH / 2) * scale))
  const cellH = Math.max(1, Math.round((CELL_HEIGHT / 2) * scale))
  const padding = Math.max(0, Math.round(options?.padding ?? 16 * scale))
  const bg = options?.background ?? DEFAULT_BG

  let lines = parseAnsi(ansiText.replace(/\r\n/g, '\n'))
  let start = 0
  while (start < lines.length && isBlankLine(lines[start]!)) start++
  let end = lines.length - 1
  while (end >= start && isBlankLine(lines[end]!)) end--
  lines = start <= end ? lines.slice(start, end + 1) : [lines[0] ?? []]

  let maxCols = 1
  for (const line of lines) {
    const cols = measureLineColumns(line)
    if (cols > maxCols) maxCols = cols
  }

  const width = Math.max(1, maxCols * cellW + padding * 2)
  const height = Math.max(1, lines.length * cellH + padding * 2)
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = bg.r
    pixels[i + 1] = bg.g
    pixels[i + 2] = bg.b
    pixels[i + 3] = 255
  }

  const font = getFont()
  const fallback = getFallbackGlyph()

  for (let row = 0; row < lines.length; row++) {
    const originY = padding + row * cellH
    let col = 0
    for (const span of lines[row]!) {
      for (const ch of span.text) {
        if (ch === '\r') continue
        const w = stringWidth(ch)
        if (w <= 0) continue
        const originX = padding + col * cellW
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
