import { deflateSync } from 'node:zlib'

import { stringWidth } from '../ink/stringWidth.js'
import { DEFAULT_BG, parseAnsi, type AnsiColor, type ParsedLine } from './ansiToSvg.js'

/**
 * Render ANSI-escaped terminal text straight to a PNG: parsed spans are
 * painted into an RGBA pixel buffer with a bundled bitmap font and encoded
 * with the platform deflate. No SVG intermediate and no external
 * rasteriser — the previous WASM rasteriser cost megabytes, depended on a
 * hard-coded system font path (blank screenshots when missing), and was
 * 15–40x slower.
 *
 * The font is a Mercury-designed stroke font rasterised at module load into
 * 24x48 cells with 8-bit anti-aliased alpha, then packed and re-read
 * through the font container format (little-endian uint16 glyph count, then
 * per glyph a little-endian uint32 codepoint followed by 24*48 alpha
 * bytes). The container format and cell geometry are the contract; the
 * glyph artwork is original. Codepoints outside the set render as a dotted
 * rectangle fallback.
 */

const CELL_WIDTH = 24
const CELL_HEIGHT = 48
const CELL_BYTES = CELL_WIDTH * CELL_HEIGHT

// ---------------------------------------------------------------------------
// Stroke font. Glyphs are polylines on a small design grid: x in [0..6],
// y 0 = cap top, y 9 = baseline, y 12 = descender floor. Each polyline is a
// flat [x0, y0, x1, y1, ...] list. Coordinates outside the grid are allowed
// (full-cell box-drawing strokes) and clamp at raster time.
// ---------------------------------------------------------------------------

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
  // Unicode characters the stats output uses.
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

function rasterizeStrokes(polylines: StrokeGlyph): Uint8Array {
  const cell = new Uint8Array(CELL_BYTES)
  const mapX = (x: number): number => 2 + (x * 20) / 6
  const mapY = (y: number): number => 6 + y * 3
  for (const polyline of polylines) {
    for (let s = 0; s + 3 < polyline.length; s += 2) {
      const x1 = mapX(polyline[s] as number)
      const y1 = mapY(polyline[s + 1] as number)
      const x2 = mapX(polyline[s + 2] as number)
      const y2 = mapY(polyline[s + 3] as number)
      const length = Math.hypot(x2 - x1, y2 - y1)
      const steps = Math.max(1, Math.ceil(length / 0.3))
      for (let i = 0; i <= steps; i++) {
        const cx = x1 + ((x2 - x1) * i) / steps
        const cy = y1 + ((y2 - y1) * i) / steps
        const minX = Math.max(0, Math.floor(cx - STROKE_RADIUS - 1))
        const maxX = Math.min(CELL_WIDTH - 1, Math.ceil(cx + STROKE_RADIUS + 1))
        const minY = Math.max(0, Math.floor(cy - STROKE_RADIUS - 1))
        const maxY = Math.min(CELL_HEIGHT - 1, Math.ceil(cy + STROKE_RADIUS + 1))
        for (let py = minY; py <= maxY; py++) {
          for (let px = minX; px <= maxX; px++) {
            const dist = Math.hypot(px + 0.5 - cx, py + 0.5 - cy)
            const coverage = Math.max(0, Math.min(1, STROKE_RADIUS + 0.5 - dist))
            if (coverage <= 0) continue
            const alpha = Math.round(coverage * 255)
            const index = py * CELL_WIDTH + px
            if (alpha > (cell[index] as number)) cell[index] = alpha
          }
        }
      }
    }
  }
  return cell
}

/**
 * Pack glyph cells into the font container format: little-endian uint16
 * glyph count, then per glyph a little-endian uint32 codepoint followed by
 * 24*48 alpha bytes.
 */
function packFontContainer(glyphs: Array<[number, Uint8Array]>): Uint8Array {
  const packed = new Uint8Array(2 + glyphs.length * (4 + CELL_BYTES))
  const view = new DataView(packed.buffer)
  view.setUint16(0, glyphs.length, true)
  let offset = 2
  for (const [codepoint, cell] of glyphs) {
    view.setUint32(offset, codepoint, true)
    offset += 4
    packed.set(cell, offset)
    offset += CELL_BYTES
  }
  return packed
}

/** Parse the font container format back into a codepoint→cell map. */
function parseFontContainer(packed: Uint8Array): Map<number, Uint8Array> {
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
  const count = view.getUint16(0, true)
  const glyphs = new Map<number, Uint8Array>()
  let offset = 2
  for (let i = 0; i < count; i++) {
    const codepoint = view.getUint32(offset, true)
    offset += 4
    glyphs.set(codepoint, packed.subarray(offset, offset + CELL_BYTES))
    offset += CELL_BYTES
  }
  return glyphs
}

let fontCache: Map<number, Uint8Array> | null = null

function getFont(): Map<number, Uint8Array> {
  if (!fontCache) {
    const rasterized: Array<[number, Uint8Array]> = Object.entries(STROKE_GLYPHS).map(
      ([char, strokes]) => [char.codePointAt(0) as number, rasterizeStrokes(strokes)],
    )
    fontCache = parseFontContainer(packFontContainer(rasterized))
  }
  return fontCache
}

/**
 * Fallback for codepoints absent from the font: a dotted rectangle outline —
 * a border inset one pixel horizontally, running from row 2 to row
 * height-5, with alternating (checkerboard-parity) pixels at full alpha.
 */
let fallbackGlyphCache: Uint8Array | null = null

function getFallbackGlyph(): Uint8Array {
  if (!fallbackGlyphCache) {
    const cell = new Uint8Array(CELL_BYTES)
    const top = 2
    const bottom = CELL_HEIGHT - 5
    const left = 1
    const right = CELL_WIDTH - 2
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const onBorder = y === top || y === bottom || x === left || x === right
        if (onBorder && (x + y) % 2 === 0) {
          cell[y * CELL_WIDTH + x] = 255
        }
      }
    }
    fallbackGlyphCache = cell
  }
  return fallbackGlyphCache
}

// Shade characters are not drawn from the font: modern terminals render
// them as opacity blocks, not VGA dither patterns, so they are filled as
// solid cells with the foreground blended toward the background.
const SHADE_BLEND: Record<string, number> = {
  '░': 0.25,
  '▒': 0.5,
  '▓': 0.75,
  '█': 1.0,
}

// ---------------------------------------------------------------------------
// PNG encoding: signature; IHDR (bit depth 8, colour type 6 RGBA,
// compression 0, filter 0, interlace 0); one IDAT holding the deflate of
// all scanlines each prefixed with filter byte 0; IEND. Chunk framing is a
// big-endian length, 4-byte ASCII type, data, and a big-endian CRC-32
// (polynomial 0xEDB88320) over type+data.
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 'ascii')
  chunk.set(data, 8)
  const crc = crc32(chunk.subarray(4, 8 + data.length))
  chunk.writeUInt32BE(crc, 8 + data.length)
  return chunk
}

function encodePng(pixels: Buffer, width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4)
    raw[rowStart] = 0 // filter byte
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type AnsiToPngOptions = {
  /** Integer nearest-neighbour scale. */
  scale?: number
  /** Horizontal padding in 1x pixels. */
  paddingX?: number
  /** Vertical padding in 1x pixels. */
  paddingY?: number
  /** Corner radius in 1x pixels. */
  borderRadius?: number
  background?: AnsiColor
}

function isBlankLine(line: ParsedLine): boolean {
  return line.every(span => /^\s*$/.test(span.text))
}

export function ansiToPng(ansiText: string, options: AnsiToPngOptions = {}): Buffer {
  const {
    scale = 1,
    paddingX = 48,
    paddingY = 48,
    borderRadius = 16,
    background: backgroundColor = DEFAULT_BG,
  } = options

  const lines = parseAnsi(ansiText)
  while (lines.length > 0 && isBlankLine(lines[lines.length - 1] as ParsedLine)) {
    lines.pop()
  }
  if (lines.length === 0) {
    // Unlike the SVG path, substitute a single empty line so the image is
    // still valid.
    lines.push([{ text: '', color: { r: 229, g: 229, b: 229 }, bold: false }])
  }

  // Terminal-cell width (wide characters count as 2), floored at 1.
  let columns = 1
  for (const line of lines) {
    const cells = stringWidth(line.map(span => span.text).join(''))
    if (cells > columns) columns = cells
  }
  const rows = lines.length

  const width = (columns * CELL_WIDTH + 2 * paddingX) * scale
  const height = (rows * CELL_HEIGHT + 2 * paddingY) * scale
  const pixels = Buffer.alloc(width * height * 4)

  // Opaque background fill.
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = backgroundColor.r
    pixels[i * 4 + 1] = backgroundColor.g
    pixels[i * 4 + 2] = backgroundColor.b
    pixels[i * 4 + 3] = 255
  }

  // Round the corners by zeroing the alpha outside a quarter-circle in each
  // corner, using half-pixel centres.
  const radius = borderRadius * scale
  if (radius > 0) {
    const corners: Array<[number, number, number, number]> = [
      // [x origin, y origin, centre x, centre y]
      [0, 0, radius, radius],
      [width - radius, 0, width - radius, radius],
      [0, height - radius, radius, height - radius],
      [width - radius, height - radius, width - radius, height - radius],
    ]
    for (const [originX, originY, centreX, centreY] of corners) {
      for (let y = 0; y < radius; y++) {
        for (let x = 0; x < radius; x++) {
          const px = originX + x
          const py = originY + y
          const dx = px + 0.5 - centreX
          const dy = py + 0.5 - centreY
          if (dx * dx + dy * dy > radius * radius) {
            pixels[(py * width + px) * 4 + 3] = 0
          }
        }
      }
    }
  }

  const font = getFont()
  const fallback = getFallbackGlyph()

  const blitGlyph = (
    cell: Uint8Array,
    cellX: number,
    cellY: number,
    color: AnsiColor,
    bold: boolean,
  ): void => {
    for (let gy = 0; gy < CELL_HEIGHT; gy++) {
      for (let gx = 0; gx < CELL_WIDTH; gx++) {
        const rawAlpha = cell[gy * CELL_WIDTH + gx] as number
        // Fully transparent glyph pixels are skipped outright, so the
        // background (including zeroed corner alpha) shows through.
        if (rawAlpha === 0) continue
        // Bold is synthesised by boosting the alpha — there is no second
        // font weight.
        const alpha = bold ? Math.min(255, Math.round(rawAlpha * 1.4)) : rawAlpha
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = (cellX + gx) * scale + sx
            const py = (cellY + gy) * scale + sy
            if (px < 0 || px >= width || py < 0 || py >= height) continue
            const offset = (py * width + px) * 4
            // Blend dividing by 256 via the shift — slightly darker than a
            // true composite, uniformly across the image. The alpha channel
            // is not written by glyph blitting.
            pixels[offset] = (color.r * alpha + (pixels[offset] as number) * (256 - alpha)) >> 8
            pixels[offset + 1] =
              (color.g * alpha + (pixels[offset + 1] as number) * (256 - alpha)) >> 8
            pixels[offset + 2] =
              (color.b * alpha + (pixels[offset + 2] as number) * (256 - alpha)) >> 8
          }
        }
      }
    }
  }

  const fillShadeCell = (cellX: number, cellY: number, color: AnsiColor, blend: number): void => {
    const r = Math.round(color.r * blend + backgroundColor.r * (1 - blend))
    const g = Math.round(color.g * blend + backgroundColor.g * (1 - blend))
    const b = Math.round(color.b * blend + backgroundColor.b * (1 - blend))
    for (let gy = 0; gy < CELL_HEIGHT; gy++) {
      for (let gx = 0; gx < CELL_WIDTH; gx++) {
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = (cellX + gx) * scale + sx
            const py = (cellY + gy) * scale + sy
            if (px < 0 || px >= width || py < 0 || py >= height) continue
            const offset = (py * width + px) * 4
            pixels[offset] = r
            pixels[offset + 1] = g
            pixels[offset + 2] = b
          }
        }
      }
    }
  }

  for (let row = 0; row < rows; row++) {
    const line = lines[row] as ParsedLine
    // The column counter runs across spans within a line, resetting per line.
    let column = 0
    for (const span of line) {
      // Iterate per code point so surrogate pairs stay whole.
      for (const char of span.text) {
        const cellWidth = stringWidth(char)
        // Zero-width characters (combining marks) are neither drawn nor
        // advanced.
        if (cellWidth === 0) continue
        const cellX = paddingX + column * CELL_WIDTH
        const cellY = paddingY + row * CELL_HEIGHT
        const shade = SHADE_BLEND[char]
        if (shade !== undefined) {
          fillShadeCell(cellX, cellY, span.color, shade)
        } else {
          const glyph = font.get(char.codePointAt(0) as number)
          // A wide character advances two cells but is painted into a
          // single cell; there is no double-width raster.
          blitGlyph(glyph ?? fallback, cellX, cellY, span.color, span.bold)
        }
        column += cellWidth
      }
    }
  }

  return encodePng(pixels, width, height)
}
