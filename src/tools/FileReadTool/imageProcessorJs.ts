import { deflateSync, inflateSync } from 'node:zlib'

import type { SharpFunction, SharpInstance } from './imageProcessor.js'

export type HeaderFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp'

export function imageDimensionsFromHeader(buffer: Buffer): { width: number; height: number; format: HeaderFormat } | null {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' }
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), format: 'gif' }
  }
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    const headerSize = buffer.readUInt32LE(14)
    if (headerSize === 12) return { width: buffer.readUInt16LE(18), height: buffer.readUInt16LE(20), format: 'bmp' }
    return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)), format: 'bmp' }
  }
  if (
    buffer.length >= 30 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    const chunk = buffer.toString('latin1', 12, 16)
    if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, format: 'webp' }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' }
    }
    if (chunk === 'VP8X') {
      const width = (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16)) + 1
      const height = (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16)) + 1
      return { width, height, format: 'webp' }
    }
    return null
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = buffer[offset + 1]!
      if (marker === 0xff) {
        offset++
        continue
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7), format: 'jpeg' }
      }
      if (marker === 0xda || marker === 0xd9) break
      offset += 2 + length
    }
    return null
  }
  return null
}


export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

export class JavascriptImageRoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JavascriptImageRoadError'
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function decodePng(buffer: Buffer): RgbaImage {
  if (!(buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)) {
    throw new JavascriptImageRoadError('not a PNG')
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  const idat: Buffer[] = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]!
      colorType = body[9]!
      interlace = body[12]!
    } else if (type === 'PLTE') {
      palette = Buffer.from(body)
    } else if (type === 'tRNS') {
      transparency = Buffer.from(body)
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (width === 0 || height === 0) throw new JavascriptImageRoadError('PNG header carries no dimensions')
  if (interlace !== 0) throw new JavascriptImageRoadError('interlaced PNG is not decodable on the JavaScript road')
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4
  const bitsPerPixel = channels * bitDepth
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length < (stride + 1) * height) throw new JavascriptImageRoadError('PNG image data is shorter than its dimensions need')

  const rows = new Uint8Array(stride * height)
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = rows.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i++) {
      const left = i >= bytesPerPixel ? row[i - bytesPerPixel]! : 0
      const up = previous[i]!
      const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel]! : 0
      const value = src[i]!
      let out: number
      switch (filter) {
        case 0: out = value; break
        case 1: out = value + left; break
        case 2: out = value + up; break
        case 3: out = value + ((left + up) >> 1); break
        case 4: out = value + paeth(left, up, upLeft); break
        default: throw new JavascriptImageRoadError(`PNG row ${y} uses unknown filter ${filter}`)
      }
      row[i] = out & 0xff
    }
    previous = row
  }

  const data = new Uint8Array(width * height * 4)
  const sampleAt = (row: Uint8Array, index: number): number => {
    if (bitDepth === 8) return row[index]!
    if (bitDepth === 16) return row[index * 2]!
    const perByte = 8 / bitDepth
    const byte = row[Math.floor(index / perByte)]!
    const shift = 8 - bitDepth * ((index % perByte) + 1)
    const value = (byte >> shift) & ((1 << bitDepth) - 1)
    return colorType === 3 ? value : Math.round((value * 255) / ((1 << bitDepth) - 1))
  }
  const transparentGray = transparency && colorType === 0 ? transparency.readUInt16BE(0) : -1
  const transparentRgb = transparency && colorType === 2 ? [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)] : null
  const maxSample = (1 << Math.min(bitDepth, 16)) - 1
  const to8 = (v: number): number => (bitDepth === 16 ? v >> 8 : bitDepth === 8 ? v : Math.round((v * 255) / maxSample))
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      switch (colorType) {
        case 0: {
          const g = sampleAt(row, x)
          data[o] = g
          data[o + 1] = g
          data[o + 2] = g
          data[o + 3] = transparentGray >= 0 && to8(transparentGray) === g ? 0 : 255
          break
        }
        case 2: {
          const r = sampleAt(row, x * 3)
          const g = sampleAt(row, x * 3 + 1)
          const b = sampleAt(row, x * 3 + 2)
          data[o] = r
          data[o + 1] = g
          data[o + 2] = b
          data[o + 3] = transparentRgb && to8(transparentRgb[0]!) === r && to8(transparentRgb[1]!) === g && to8(transparentRgb[2]!) === b ? 0 : 255
          break
        }
        case 3: {
          const index = sampleAt(row, x)
          data[o] = palette?.[index * 3] ?? 0
          data[o + 1] = palette?.[index * 3 + 1] ?? 0
          data[o + 2] = palette?.[index * 3 + 2] ?? 0
          data[o + 3] = transparency && index < transparency.length ? transparency[index]! : 255
          break
        }
        case 4: {
          const g = sampleAt(row, x * 2)
          data[o] = g
          data[o + 1] = g
          data[o + 2] = g
          data[o + 3] = sampleAt(row, x * 2 + 1)
          break
        }
        default: {
          data[o] = sampleAt(row, x * 4)
          data[o + 1] = sampleAt(row, x * 4 + 1)
          data[o + 2] = sampleAt(row, x * 4 + 2)
          data[o + 3] = sampleAt(row, x * 4 + 3)
        }
      }
    }
  }
  return { width, height, data }
}

export function decodeBmp(buffer: Buffer): RgbaImage {
  if (!(buffer.length >= 54 && buffer[0] === 0x42 && buffer[1] === 0x4d)) throw new JavascriptImageRoadError('not a BMP')
  const pixelOffset = buffer.readUInt32LE(10)
  const width = buffer.readInt32LE(18)
  const rawHeight = buffer.readInt32LE(22)
  const height = Math.abs(rawHeight)
  const bottomUp = rawHeight > 0
  const bits = buffer.readUInt16LE(28)
  const compression = buffer.readUInt32LE(30)
  if (!(bits === 16 || bits === 24 || bits === 32) || (compression !== 0 && compression !== 3)) {
    throw new JavascriptImageRoadError(`BMP ${bits}-bit compression ${compression} is not decodable on the JavaScript road`)
  }
  const rowBytes = Math.floor((bits * width + 31) / 32) * 4
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const srcRow = pixelOffset + (bottomUp ? height - 1 - y : y) * rowBytes
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (bits === 32) {
        const p = srcRow + x * 4
        data[o] = buffer[p + 2]!
        data[o + 1] = buffer[p + 1]!
        data[o + 2] = buffer[p]!
        data[o + 3] = 255
      } else if (bits === 24) {
        const p = srcRow + x * 3
        data[o] = buffer[p + 2]!
        data[o + 1] = buffer[p + 1]!
        data[o + 2] = buffer[p]!
        data[o + 3] = 255
      } else {
        const v = buffer.readUInt16LE(srcRow + x * 2)
        data[o] = ((v >> 10) & 0x1f) * 255 / 31
        data[o + 1] = ((v >> 5) & 0x1f) * 255 / 31
        data[o + 2] = (v & 0x1f) * 255 / 31
        data[o + 3] = 255
      }
    }
  }
  return { width, height, data }
}

export function decodeImage(buffer: Buffer): RgbaImage {
  const header = imageDimensionsFromHeader(buffer)
  if (header?.format === 'png') return decodePng(buffer)
  if (header?.format === 'bmp') return decodeBmp(buffer)
  throw new JavascriptImageRoadError(
    `${header ? header.format.toUpperCase() : 'this'} image data is not decodable on the JavaScript road (PNG and BMP are); the native image processor is needed to re-encode it`,
  )
}


export function downscaleRgba(image: RgbaImage, targetWidth: number, targetHeight: number): RgbaImage {
  const width = Math.max(1, Math.round(targetWidth))
  const height = Math.max(1, Math.round(targetHeight))
  if (width >= image.width && height >= image.height) return image
  const out = new Uint8Array(width * height * 4)
  const sx = image.width / width
  const sy = image.height / height
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * image.width + x0) * 4
        for (let xx = x0; xx < x1; xx++) {
          r += image.data[p]!
          g += image.data[p + 1]!
          b += image.data[p + 2]!
          a += image.data[p + 3]!
          p += 4
          n++
        }
      }
      const o = (y * width + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return { width, height, data: out }
}


const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + body.length)
  chunk.writeUInt32BE(body.length, 0)
  chunk.write(type, 4, 'latin1')
  chunk.set(body, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + body.length)), 8 + body.length)
  return chunk
}

export function encodePng(image: RgbaImage, options: { compressionLevel?: number } = {}): Buffer {
  const { width, height, data } = image
  let opaque = true
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      opaque = false
      break
    }
  }
  const channels = opaque ? 3 : 4
  const stride = width * channels
  const raw = new Uint8Array((stride + 1) * height)
  const previous = new Uint8Array(stride)
  const current = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      const d = x * channels
      current[d] = data[s]!
      current[d + 1] = data[s + 1]!
      current[d + 2] = data[s + 2]!
      if (!opaque) current[d + 3] = data[s + 3]!
    }
    const rowStart = y * (stride + 1)
    raw[rowStart] = 4
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels]! : 0
      const up = previous[i]!
      const upLeft = i >= channels ? previous[i - channels]! : 0
      raw[rowStart + 1 + i] = (current[i]! - paeth(left, up, upLeft)) & 0xff
    }
    previous.set(current)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = opaque ? 2 : 6
  header[10] = 0
  header[11] = 0
  header[12] = 0
  const level = Math.min(6, Math.max(0, options.compressionLevel ?? 6))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level })),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}


class JavascriptImageInstance implements SharpInstance {
  private target: { width: number | null; height: number | null; withoutEnlargement: boolean } | null = null
  private compressionLevel = 6

  constructor(private readonly input: Buffer) {}

  async metadata(): Promise<{ width?: number; height?: number; format?: string }> {
    const header = imageDimensionsFromHeader(this.input)
    if (header === null) return {}
    return { width: header.width, height: header.height, format: header.format }
  }

  resize(width: number | null, height?: number | null, options?: { fit?: string; withoutEnlargement?: boolean }): SharpInstance {
    this.target = { width, height: height ?? null, withoutEnlargement: options?.withoutEnlargement ?? false }
    return this
  }

  jpeg(): SharpInstance {
    return this
  }

  png(options?: { compressionLevel?: number }): SharpInstance {
    if (options?.compressionLevel !== undefined) this.compressionLevel = options.compressionLevel
    return this
  }

  webp(): SharpInstance {
    return this
  }

  async toBuffer(): Promise<Buffer> {
    let image = decodeImage(this.input)
    if (this.target !== null && (this.target.width !== null || this.target.height !== null)) {
      const boxWidth = this.target.width ?? Number.POSITIVE_INFINITY
      const boxHeight = this.target.height ?? Number.POSITIVE_INFINITY
      const scale = Math.min(boxWidth / image.width, boxHeight / image.height)
      if (scale < 1 || !this.target.withoutEnlargement) {
        if (scale < 1) image = downscaleRgba(image, Math.round(image.width * scale), Math.round(image.height * scale))
      }
    }
    return encodePng(image, { compressionLevel: this.compressionLevel })
  }
}

export const javascriptImageProcessor: SharpFunction = (input?: Buffer | string): SharpInstance => {
  if (!Buffer.isBuffer(input)) {
    throw new JavascriptImageRoadError('the JavaScript image road processes buffers only')
  }
  return new JavascriptImageInstance(input)
}
