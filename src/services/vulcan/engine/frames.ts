import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { inflateSync } from 'node:zlib'
import { decodePng, downscaleRgba, encodePng, type RgbaImage } from '../../../tools/FileReadTool/imageProcessorJs.js'
import { engineFramesDirPrefix, engineRunPath, engineRunResultFile, engineRunsDir, ensureEngineEstate, isEngineJobId } from './paths.js'

const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_PIXELS = 4 * 1024 * 1024
const MAX_DIMENSION = 8192
const MAX_FRAMES = 64
const MAX_SHEET_INPUT_PIXELS = 64 * 1024 * 1024
const MAX_CORRELATION_PAIRS = 268435456
const MAX_COMPONENTS = 4096
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

type Rectangle = { x: number; y: number; width: number; height: number }
type WrittenImage = { path: string; width: number; height: number }
type ContactSheet = WrittenImage & { frames: Array<Rectangle & { path: string; index: number }> }
type Correlation = { lag: number; correlation: number | null }

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096 || value.includes('\0')) {
    throw new Error(`${name} must be a nonempty local path or identifier`)
  }
  return value
}

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const number = value === undefined ? fallback : value
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return number
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function boundedFile(file: string, maximum: number): Buffer {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error(`Expected a nonempty regular file no larger than ${maximum} bytes: ${file}`)
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null)
      if (count === 0) throw new Error(`File changed while reading: ${file}`)
      offset += count
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) throw new Error(`File changed while reading: ${file}`)
    return buffer
  } finally {
    closeSync(descriptor)
  }
}

function pngHeader(buffer: Buffer): { width: number; height: number; rawBytes: number } {
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.readUInt32BE(8) !== 13 || buffer.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('Frame must be a PNG with an IHDR header')
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error(`PNG dimensions must be 1..${MAX_DIMENSION} and contain at most ${MAX_PIXELS} pixels`)
  }
  const depth = buffer[24]!
  const type = buffer[25]!
  const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
  if (!depths[type]?.includes(depth) || buffer[26] !== 0 || buffer[27] !== 0 || buffer[28] !== 0) {
    throw new Error('PNG must use a supported bit depth, standard compression and filtering, and no interlacing')
  }
  const channels = type === 0 || type === 3 ? 1 : type === 2 ? 3 : type === 4 ? 2 : 4
  return { width, height, rawBytes: (Math.ceil(width * channels * depth / 8) + 1) * height }
}

function readPng(file: string, remainingPixels: number = MAX_PIXELS): RgbaImage {
  const buffer = boundedFile(file, MAX_FILE_BYTES)
  const header = pngHeader(buffer)
  if (header.width * header.height > remainingPixels) throw new Error(`Contact sheet inputs exceed ${MAX_SHEET_INPUT_PIXELS} pixels`)
  const idat: Buffer[] = []
  let offset = 8
  let chunks = 0
  let ended = false
  let paletteEntries = 0
  let transparency = false
  let dataEnded = false
  while (offset + 12 <= buffer.length) {
    if (++chunks > 4096) throw new Error('PNG contains too many chunks')
    const length = buffer.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > buffer.length) throw new Error('PNG contains a truncated chunk')
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let crc = 0xffffffff
    for (let index = offset + 4; index < end - 4; index++) crc = CRC_TABLE[(crc ^ buffer[index]!) & 255]! ^ (crc >>> 8)
    if (((crc ^ 0xffffffff) >>> 0) !== buffer.readUInt32BE(end - 4)) throw new Error(`PNG ${type} checksum does not match`)
    if (type === 'IHDR' && offset !== 8) throw new Error('PNG contains repeated headers')
    if (type === 'PLTE') {
      if (paletteEntries || idat.length || length < 3 || length > 768 || length % 3 !== 0 || buffer[25] === 0 || buffer[25] === 4) throw new Error('PNG contains an invalid palette')
      paletteEntries = length / 3
      if (buffer[25] === 3 && paletteEntries > 2 ** buffer[24]!) throw new Error('PNG palette exceeds its bit depth')
    } else if (type === 'tRNS') {
      const colorType = buffer[25]!
      if (transparency || idat.length || !((colorType === 0 && length === 2) || (colorType === 2 && length === 6) || (colorType === 3 && length >= 1 && length <= paletteEntries))) throw new Error('PNG contains invalid transparency')
      transparency = true
    } else if (type === 'IDAT') {
      if (dataEnded || (buffer[25] === 3 && paletteEntries === 0)) throw new Error('PNG image data is out of order or has no palette')
      idat.push(buffer.subarray(offset + 8, end - 4))
    } else if (type === 'IEND') {
      if (length !== 0 || end !== buffer.length) throw new Error('PNG contains an invalid ending')
      ended = true
      break
    } else if (type !== 'IHDR' && (buffer[offset + 4]! & 32) === 0) {
      throw new Error(`PNG contains an unsupported critical chunk: ${type}`)
    }
    if (idat.length > 0 && type !== 'IDAT') dataEnded = true
    offset = end
  }
  if (!ended || idat.length === 0) throw new Error('PNG is missing image data or its ending')
  const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: header.rawBytes })
  if (inflated.length !== header.rawBytes) throw new Error('PNG image data does not match its dimensions')
  const image = decodePng(buffer)
  if (image.width !== header.width || image.height !== header.height || image.data.length !== header.width * header.height * 4) throw new Error('PNG decode dimensions do not match its header')
  return image
}

function thumbnail(image: RgbaImage, bound: number): RgbaImage {
  const scale = Math.min(1, bound / image.width, bound / image.height)
  return downscaleRgba(image, Math.max(1, Math.floor(image.width * scale)), Math.max(1, Math.floor(image.height * scale)))
}

function writeImage(image: RgbaImage, file: string): WrittenImage {
  writeFileSync(file, encodePng(image), { flag: 'wx', mode: 0o600 })
  return { path: file, width: image.width, height: image.height }
}

function newFramesDirectory(projectRoot: string): string {
  const root = realpathSync(projectRoot)
  const runs = engineRunsDir(root)
  if (!inside(root, runs)) throw new Error('Engine run estate must be inside the project')
  let directory = root
  for (const segment of path.relative(root, runs).split(path.sep)) {
    directory = path.join(directory, segment)
    try {
      mkdirSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Engine run estate cannot use a linked or non-directory path: ${directory}`)
  }
  ensureEngineEstate(root)
  return mkdtempSync(engineFramesDirPrefix(root))
}

function writeUnder<T>(projectRoot: string, write: (directory: string) => T): T {
  const directory = newFramesDirectory(projectRoot)
  try {
    return write(directory)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

function framePath(value: unknown, root: string, name: string): string {
  return realpathSync(path.resolve(root, text(value, name)))
}

function diff(args: Record<string, unknown>, root: string): object {
  const threshold = args.threshold === undefined ? 0 : args.threshold
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 255) throw new Error('threshold must be a finite number from 0 to 255')
  const a = framePath(args.a, root, 'a')
  const b = framePath(args.b, root, 'b')
  const first = readPng(a)
  const second = readPng(b)
  const { width, height } = first
  if (width !== second.width || height !== second.height) throw new Error('Diff frames must have identical dimensions')
  const count = width * height
  const changed = new Uint8Array(count)
  const mask: RgbaImage = { width, height, data: new Uint8Array(count * 4) }
  let changedPixels = 0
  for (let index = 0; index < count; index++) {
    const pixel = index * 4
    let delta = 0
    for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(first.data[pixel + channel]! - second.data[pixel + channel]!))
    if (delta > threshold) {
      changed[index] = 1
      changedPixels++
      mask.data[pixel] = 255
      mask.data[pixel + 1] = 255
      mask.data[pixel + 2] = 255
    }
    mask.data[pixel + 3] = 255
  }
  const components: Array<Rectangle & { pixels: number }> = []
  const queue = new Uint32Array(changedPixels)
  for (let start = 0; start < count; start++) {
    if (!changed[start]) continue
    if (components.length === MAX_COMPONENTS) throw new Error(`Diff exceeds ${MAX_COMPONENTS} connected components`)
    let read = 0
    let write = 1
    queue[0] = start
    changed[start] = 0
    let minX = start % width
    let maxX = minX
    let minY = Math.floor(start / width)
    let maxY = minY
    while (read < write) {
      const index = queue[read++]!
      const x = index % width
      const y = Math.floor(index / width)
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      if (x > 0 && changed[index - 1]) { changed[index - 1] = 0; queue[write++] = index - 1 }
      if (x + 1 < width && changed[index + 1]) { changed[index + 1] = 0; queue[write++] = index + 1 }
      if (y > 0 && changed[index - width]) { changed[index - width] = 0; queue[write++] = index - width }
      if (y + 1 < height && changed[index + width]) { changed[index + width] = 0; queue[write++] = index + width }
    }
    components.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels: write })
  }
  const small = thumbnail(mask, 320)
  return writeUnder(root, directory => ({ action: 'diff', a, b, width, height, threshold, changedPixels, changedFraction: changedPixels / count, components, mask: writeImage(small, path.join(directory, 'mask.png')) }))
}

function correlations(values: Float64Array, width: number, height: number, maxLag: number, horizontal: boolean): Correlation[] {
  const result: Correlation[] = []
  for (let lag = 1; lag <= Math.min(maxLag, (horizontal ? width : height) - 1); lag++) {
    const columns = horizontal ? width - lag : width
    const rows = horizontal ? height : height - lag
    const delta = horizontal ? lag : lag * width
    const originA = values[0]!
    const originB = values[delta]!
    let sumA = 0
    let sumB = 0
    let sumAA = 0
    let sumBB = 0
    let sumAB = 0
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const index = y * width + x
        const a = values[index]! - originA
        const b = values[index + delta]! - originB
        sumA += a
        sumB += b
        sumAA += a * a
        sumBB += b * b
        sumAB += a * b
      }
    }
    const count = rows * columns
    const varianceA = Math.max(0, sumAA - sumA * sumA / count)
    const varianceB = Math.max(0, sumBB - sumB * sumB / count)
    const denominator = Math.sqrt(varianceA * varianceB)
    result.push({ lag, correlation: denominator === 0 ? null : Math.max(-1, Math.min(1, (sumAB - sumA * sumB / count) / denominator)) })
  }
  return result
}

function stats(args: Record<string, unknown>, root: string): object {
  const maxLag = integer(args.maxLag, 32, 1, 128, 'maxLag')
  const grid = args.grid === undefined ? [1, 1] : args.grid
  if (!Array.isArray(grid) || grid.length !== 2 || typeof grid[0] !== 'number' || typeof grid[1] !== 'number') throw new Error('grid must be [columns, rows]')
  const columns = integer(grid[0], 1, 1, 64, 'grid columns')
  const rows = integer(grid[1], 1, 1, 64, 'grid rows')
  const frame = framePath(args.frame, root, 'frame')
  const image = readPng(frame)
  const { width, height } = image
  if (columns > width || rows > height) throw new Error('Grid cannot have more columns or rows than the frame')
  const horizontalLags = Math.min(maxLag, width - 1)
  const verticalLags = Math.min(maxLag, height - 1)
  const pairCount = height * (horizontalLags * width - horizontalLags * (horizontalLags + 1) / 2) + width * (verticalLags * height - verticalLags * (verticalLags + 1) / 2)
  if (pairCount > MAX_CORRELATION_PAIRS) throw new Error(`Autocorrelation exceeds ${MAX_CORRELATION_PAIRS} pixel pairs; reduce maxLag or frame dimensions`)
  const count = width * height
  const luminance = new Float64Array(count)
  for (let index = 0; index < count; index++) luminance[index] = (0.2126 * image.data[index * 4]! + 0.7152 * image.data[index * 4 + 1]! + 0.0722 * image.data[index * 4 + 2]!) / 255
  let xx = 0
  let xy = 0
  let yy = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const gx = x + 1 < width ? luminance[index + 1]! - luminance[index]! : 0
      const gy = y + 1 < height ? luminance[index + width]! - luminance[index]! : 0
      xx += gx * gx
      xy += gx * gy
      yy += gy * gy
    }
  }
  const edges = (width - 1) * height + (height - 1) * width
  const highFrequencyEnergy = edges === 0 ? 0 : Math.max(0, Math.min(1, (xx + yy) / edges))
  xx /= count
  xy /= count
  yy /= count
  const trace = xx + yy
  const strength = trace === 0 ? 0 : Math.min(1, Math.hypot(xx - yy, 2 * xy) / trace)
  const orientationDegrees = strength <= 1e-12 ? null : ((Math.atan2(2 * xy, xx - yy) * 90 / Math.PI + 90) % 180 + 180) % 180
  const regions: Array<Rectangle & { column: number; row: number; meanRgba: [number, number, number, number] }> = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = Math.floor(column * width / columns)
      const y = Math.floor(row * height / rows)
      const endX = Math.floor((column + 1) * width / columns)
      const endY = Math.floor((row + 1) * height / rows)
      const meanRgba: [number, number, number, number] = [0, 0, 0, 0]
      for (let py = y; py < endY; py++) {
        for (let px = x; px < endX; px++) {
          const pixel = (py * width + px) * 4
          for (let channel = 0; channel < 4; channel++) meanRgba[channel] = meanRgba[channel]! + image.data[pixel + channel]!
        }
      }
      const pixels = (endX - x) * (endY - y)
      for (let channel = 0; channel < 4; channel++) meanRgba[channel] = meanRgba[channel]! / pixels
      regions.push({ column, row, x, y, width: endX - x, height: endY - y, meanRgba })
    }
  }
  const autocorrelation = { rows: correlations(luminance, width, height, maxLag, true), columns: correlations(luminance, width, height, maxLag, false) }
  const small = thumbnail(image, 320)
  return writeUnder(root, directory => ({ action: 'stats', frame, width, height, autocorrelation, anisotropy: { strength, orientationDegrees, tensor: { xx, xy, yy } }, highFrequencyEnergy, grid: { columns, rows, regions }, preview: writeImage(small, path.join(directory, 'preview.png')) }))
}

function sheetImages(paths: string[]): { paths: string[]; images: RgbaImage[] } {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_FRAMES) throw new Error(`Contact sheet requires 1..${MAX_FRAMES} frame paths`)
  const resolved: string[] = []
  const images: RgbaImage[] = []
  let pixels = 0
  for (const file of paths) {
    const canonical = realpathSync(path.resolve(text(file, 'frame path')))
    const image = readPng(canonical, MAX_SHEET_INPUT_PIXELS - pixels)
    pixels += image.width * image.height
    resolved.push(canonical)
    images.push(thumbnail(image, 160))
  }
  return { paths: resolved, images }
}

function writeSheet(input: { paths: string[]; images: RgbaImage[] }, outputFile: string): ContactSheet {
  const columns = Math.ceil(Math.sqrt(input.images.length))
  const rows = Math.ceil(input.images.length / columns)
  const cellWidth = Math.max(...input.images.map(image => image.width))
  const cellHeight = Math.max(...input.images.map(image => image.height))
  const width = columns * cellWidth
  const height = rows * cellHeight
  const sheet: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) }
  for (let index = 3; index < sheet.data.length; index += 4) sheet.data[index] = 255
  const frames: ContactSheet['frames'] = []
  for (let index = 0; index < input.images.length; index++) {
    const image = input.images[index]!
    const x = index % columns * cellWidth
    const y = Math.floor(index / columns) * cellHeight
    for (let row = 0; row < image.height; row++) sheet.data.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((y + row) * width + x) * 4)
    frames.push({ path: input.paths[index]!, index, x, y, width: image.width, height: image.height })
  }
  return { ...writeImage(sheet, outputFile), frames }
}

export function writeEngineContactSheet(paths: string[], outputFile: string): ContactSheet {
  const output = text(outputFile, 'outputFile')
  if (!path.isAbsolute(output)) throw new Error('Contact sheet outputFile must be an absolute path under the run directory')
  return writeSheet(sheetImages(paths), output)
}

function contactSheet(args: Record<string, unknown>, root: string): object {
  if ((args.id === undefined) === (args.frames === undefined)) throw new Error('Contact sheet requires exactly one of id or frames')
  let paths: string[]
  if (args.id !== undefined) {
    const id = text(args.id, 'id')
    if (!isEngineJobId(id)) throw new Error('id must be a run identifier, not a path')
    const runs = realpathSync(engineRunsDir(root))
    const run = realpathSync(engineRunPath(root, id))
    if (!inside(runs, run)) throw new Error('Run path escapes the engine run estate')
    const resultPath = realpathSync(engineRunResultFile(run))
    if (!inside(run, resultPath)) throw new Error('Run result escapes its run directory')
    const record: unknown = JSON.parse(boundedFile(resultPath, 4 * 1024 * 1024).toString('utf8'))
    if (!record || typeof record !== 'object' || Array.isArray(record) || !('frames' in record) || !Array.isArray(record.frames) || record.frames.length < 1 || record.frames.length > MAX_FRAMES) throw new Error(`Run result must list 1..${MAX_FRAMES} frames`)
    paths = record.frames.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('path' in entry)) throw new Error('Each run frame must contain a path')
      const file = framePath(entry.path, run, 'run frame path')
      if (!inside(run, file)) throw new Error('Run frame escapes its run directory')
      return file
    })
  } else {
    if (!Array.isArray(args.frames) || args.frames.length < 1 || args.frames.length > MAX_FRAMES) throw new Error(`frames must contain 1..${MAX_FRAMES} paths`)
    paths = args.frames.map((file: unknown) => framePath(file, root, 'frame path'))
  }
  const input = sheetImages(paths)
  return writeUnder(root, directory => ({ action: 'contact-sheet', ...writeSheet(input, path.join(directory, 'contact-sheet.png')) }))
}

export function runEngineFrames(args: Record<string, unknown>, projectRoot: string): object {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Frame arguments must be an object')
  const action = args.action
  const fields: Record<string, readonly string[]> = { diff: ['action', 'a', 'b', 'threshold'], stats: ['action', 'frame', 'maxLag', 'grid'], 'contact-sheet': ['action', 'id', 'frames'] }
  if (typeof action !== 'string' || !Object.hasOwn(fields, action)) throw new Error('action must be diff, stats or contact-sheet')
  for (const key of Object.keys(args)) if (!fields[action]!.includes(key)) throw new Error(`Unsupported ${action} argument: ${key}`)
  const root = realpathSync(path.resolve(text(projectRoot, 'projectRoot')))
  if (!lstatSync(root).isDirectory()) throw new Error('projectRoot must be a directory')
  if (action === 'diff') return diff(args, root)
  if (action === 'stats') return stats(args, root)
  return contactSheet(args, root)
}
