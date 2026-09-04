import {
  IMAGE_LIMITS_BY_FAMILY,
  type ImageLimitFamily,
  type ImageLimits,
} from '../constants/apiLimits.js'
import { classifyModelRoute } from '../services/providers/idSpaces.js'
import { getImageProcessor, imageProcessorState, type SharpFunction } from '../tools/FileReadTool/imageProcessor.js'
import { imageDimensionsFromHeader } from '../tools/FileReadTool/imageProcessorJs.js'
import type { Base64ImageSource, ImageBlockParam } from '../types/wire.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'


export class ImageResizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageResizeError'
  }
}

export type ImageDimensions = {
  originalWidth?: number
  originalHeight?: number
  displayWidth?: number
  displayHeight?: number
}

export type ResizeResult = {
  buffer: Buffer
  mediaType: string
  dimensions?: ImageDimensions
}

export type ImageBlockWithDimensions = { block: ImageBlockParam; dimensions?: ImageDimensions }

type DetectedFormat = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export type ImageRole = 'input' | 'tool-result'

export interface ResizeOptions {
  limits?: ImageLimits
  model?: string
  imagesInRequest?: number
  role?: ImageRole
}


export function imageLimitFamilyForRoute(route: string | undefined): ImageLimitFamily {
  if (route === 'anthropic') return 'anthropic'
  if (route === 'openai') return 'openai'
  if (route === 'gemini') return 'gemini'
  return 'generic'
}

export function imageLimitsForModel(model: string | undefined): ImageLimits {
  const verdict = classifyModelRoute(model)
  return IMAGE_LIMITS_BY_FAMILY[imageLimitFamilyForRoute(verdict.kind === 'route' ? verdict.route : undefined)]
}

export function anthropicResolutionTier(model: string | undefined): 'standard' | 'highResolution' {
  const match = /^claude-(?:[a-z]+-)*(\d+)(?:[-.](\d+))?/.exec(model ?? '')
  if (match === null) return 'standard'
  const major = Number(match[1])
  const minor = match[2] === undefined ? 0 : Number(match[2])
  return major > 4 || (major === 4 && minor >= 7) ? 'highResolution' : 'standard'
}

async function mainLoopModel(): Promise<string | undefined> {
  try {
    const { getMainLoopModel } = await import('./model/model.js')
    return getMainLoopModel()
  } catch {
    return undefined
  }
}

type Caps = {
  limits: ImageLimits
  sidePx: number | null
  longEdgePx: number | null
  rawBytes: number
}

function base64LengthOf(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4
}

async function resolveCaps(options: ResizeOptions | undefined): Promise<Caps> {
  const model = options?.model ?? (options?.limits === undefined || options?.role === 'tool-result' ? await mainLoopModel() : undefined)
  const limits = options?.limits ?? imageLimitsForModel(model)
  let sidePx = limits.maxSidePx
  const inRequest = options?.imagesInRequest ?? 0
  if (limits.manyImages !== null && inRequest > limits.manyImages.threshold) {
    sidePx = sidePx === null ? limits.manyImages.maxSidePx : Math.min(sidePx, limits.manyImages.maxSidePx)
  }
  let longEdgePx: number | null = null
  if (options?.role === 'tool-result' && limits.toolResultRejectsAboveNative) {
    const tier = limits.family === 'anthropic' ? anthropicResolutionTier(model) : 'standard'
    longEdgePx = limits.nativeLongEdgePx[tier]
  }
  return { limits, sidePx, longEdgePx, rawBytes: Math.floor((limits.maxBase64Bytes / 4) * 3) }
}


export function detectImageFormatFromBuffer(buffer: Buffer): DetectedFormat {
  if (buffer.length < 4) return 'image/png'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp'
  }
  return 'image/png'
}

export function detectImageFormatFromBase64(base64: string): DetectedFormat {
  try {
    return detectImageFormatFromBuffer(Buffer.from(base64, 'base64'))
  } catch {
    return 'image/png'
  }
}

function subtypeOf(buffer: Buffer): string {
  return detectImageFormatFromBuffer(buffer).replace('image/', '')
}

function normalizeSubtype(name: string): string {
  return name === 'jpg' ? 'jpeg' : name
}


type Encoding = { kind: 'source' } | { kind: 'png'; palette: boolean } | { kind: 'jpeg'; quality: number } | { kind: 'webp'; quality: number }

async function attempt(
  sharp: SharpFunction,
  source: Buffer,
  sourceSubtype: string,
  target: { width: number; height: number } | null,
  encoding: Encoding,
): Promise<Buffer> {
  let handle = sharp(source)
  if (target !== null) handle = handle.resize(target.width, target.height, { fit: 'inside', withoutEnlargement: true })
  const kind = encoding.kind === 'source' ? sourceSubtype : encoding.kind
  if (kind === 'png' || kind === 'gif') {
    handle = handle.png(encoding.kind === 'png' ? { compressionLevel: 9, palette: encoding.palette } : { compressionLevel: 6 })
  } else if (kind === 'jpeg') {
    handle = handle.jpeg({ quality: encoding.kind === 'jpeg' ? encoding.quality : 85 })
  } else if (kind === 'webp') {
    handle = handle.webp({ quality: encoding.kind === 'webp' ? encoding.quality : 85 })
  } else {
    handle = handle.png({ compressionLevel: 6 })
  }
  return handle.toBuffer()
}

function fitDimensions(width: number, height: number, caps: Caps): { width: number; height: number } | null {
  let scale = 1
  if (caps.sidePx !== null) scale = Math.min(scale, caps.sidePx / Math.max(width, height))
  if (caps.longEdgePx !== null) scale = Math.min(scale, caps.longEdgePx / Math.max(width, height))
  if (scale >= 1) return null
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

async function readDimensions(sharp: SharpFunction, buffer: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await sharp(buffer).metadata()
    if (metadata.width && metadata.height) return { width: metadata.width, height: metadata.height }
  } catch {
  }
  const header = imageDimensionsFromHeader(buffer)
  return header === null ? null : { width: header.width, height: header.height }
}

function limitWords(caps: Caps, role: ImageRole): string {
  const parts: string[] = []
  if (caps.sidePx !== null) parts.push(`${caps.sidePx} px per side`)
  if (caps.longEdgePx !== null) parts.push(`${caps.longEdgePx} px on the long edge for a ${role === 'tool-result' ? 'tool result' : 'model input'}`)
  parts.push(`${formatFileSize(caps.limits.maxBase64Bytes)} per image as base64`)
  return `${caps.limits.family === 'generic' ? 'the strictest documented' : caps.limits.family} limits — ${parts.join(', ')} (${caps.limits.doc})`
}

export async function maybeResizeAndDownsampleImageBuffer(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
  options?: ResizeOptions,
): Promise<ResizeResult> {
  if (imageBuffer.length === 0) {
    throw new ImageResizeError('Image resizing failed: the image buffer is empty.')
  }
  const caps = await resolveCaps(options)
  const role: ImageRole = options?.role ?? 'input'
  const sharp = await getImageProcessor()
  const sourceSubtype = normalizeSubtype(imageDimensionsFromHeader(imageBuffer)?.format ?? ext)
  const dims = await readDimensions(sharp, imageBuffer)
  const fitsBytes = (bytes: number): boolean => bytes <= caps.rawBytes

  if (dims === null) {
    if (fitsBytes(originalSize)) return { buffer: imageBuffer, mediaType: sourceSubtype }
    throw new ImageResizeError(
      `The image is ${formatFileSize(originalSize)} (${formatFileSize(base64LengthOf(originalSize))} as base64), over ${limitWords(caps, role)}, and its format could not be decoded here to shrink it.`,
    )
  }

  const { width, height } = dims
  const target = fitDimensions(width, height, caps)
  const unchanged: ImageDimensions = { originalWidth: width, originalHeight: height, displayWidth: width, displayHeight: height }
  if (target === null && fitsBytes(originalSize)) {
    return { buffer: imageBuffer, mediaType: sourceSubtype, dimensions: unchanged }
  }

  const failures: string[] = []
  const tryEncode = async (dimensions: { width: number; height: number } | null, encoding: Encoding): Promise<ResizeResult | null> => {
    try {
      const produced = await attempt(sharp, imageBuffer, sourceSubtype, dimensions, encoding)
      if (!fitsBytes(produced.length)) return null
      const shown = imageDimensionsFromHeader(produced) ?? dimensions ?? { width, height }
      return {
        buffer: produced,
        mediaType: subtypeOf(produced),
        dimensions: { originalWidth: width, originalHeight: height, displayWidth: shown.width, displayHeight: shown.height },
      }
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err))
      return null
    }
  }

  const javascriptRoad = (await imageProcessorState()).road === 'javascript'
  const rungs: Array<{ dimensions: { width: number; height: number } | null; encoding: Encoding }> = []
  const base = target ?? { width, height }
  if (target !== null) rungs.push({ dimensions: target, encoding: { kind: 'source' } })
  if (!javascriptRoad) {
    rungs.push({ dimensions: target, encoding: { kind: 'png', palette: true } })
    for (const quality of [80, 60, 40]) rungs.push({ dimensions: target, encoding: { kind: 'jpeg', quality } })
  } else if (target === null) {
    rungs.push({ dimensions: null, encoding: { kind: 'png', palette: false } })
  }
  for (const scale of [0.75, 0.5, 0.35, 0.25, 0.15]) {
    const step = { width: Math.max(1, Math.floor(base.width * scale)), height: Math.max(1, Math.floor(base.height * scale)) }
    rungs.push({ dimensions: step, encoding: { kind: 'png', palette: !javascriptRoad } })
    if (!javascriptRoad) rungs.push({ dimensions: step, encoding: { kind: 'jpeg', quality: 60 } })
  }
  const last = { width: Math.max(1, Math.min(base.width, Math.floor(base.width * 0.1))), height: Math.max(1, Math.min(base.height, Math.floor(base.height * 0.1))) }
  rungs.push({ dimensions: last, encoding: javascriptRoad ? { kind: 'png', palette: false } : { kind: 'jpeg', quality: 30 } })

  for (const rung of rungs) {
    const result = await tryEncode(rung.dimensions, rung.encoding)
    if (result !== null) return result
  }

  const reasons = failures.length > 0 ? ` ${failures[0]}.` : ''
  const sizeWords = `${width}x${height} px, ${formatFileSize(originalSize)} (${formatFileSize(base64LengthOf(originalSize))} as base64)`
  if (failures.length === rungs.length) {
    throw new ImageResizeError(`The image is ${sizeWords}, over ${limitWords(caps, role)}, and it could not be re-encoded here.${reasons}`)
  }
  throw new ImageResizeError(
    `The image is ${sizeWords}; even the smallest encoding tried (${last.width}x${last.height} px ${javascriptRoad ? 'PNG' : 'JPEG'}) is over ${limitWords(caps, role)}.`,
  )
}


export async function maybeResizeAndDownsampleImageBlock(
  imageBlock: ImageBlockParam,
  options?: ResizeOptions,
): Promise<ImageBlockWithDimensions> {
  if (imageBlock.source.type !== 'base64') return { block: imageBlock }
  const buffer = Buffer.from(imageBlock.source.data, 'base64')
  const ext = imageBlock.source.media_type?.split('/')[1] || 'png'
  const result = await maybeResizeAndDownsampleImageBuffer(buffer, buffer.length, ext, options)
  return {
    block: {
      ...imageBlock,
      source: {
        type: 'base64',
        media_type: `image/${result.mediaType}` as Base64ImageSource['media_type'],
        data: result.buffer.toString('base64'),
      },
    },
    dimensions: result.dimensions,
  }
}

export async function clampToolResultImageBlocks(
  block: { type: string; content?: unknown },
  options?: Omit<ResizeOptions, 'role'>,
): Promise<void> {
  if (block.type !== 'tool_result' || !Array.isArray(block.content)) return
  const parts = block.content as unknown[]
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as { type?: string; source?: { type?: string } } | null
    if (!part || part.type !== 'image' || part.source?.type !== 'base64') continue
    try {
      const resized = await maybeResizeAndDownsampleImageBlock(part as ImageBlockParam, { ...options, role: 'tool-result' })
      parts[index] = resized.block
    } catch {
    }
  }
}


export async function compressImageBuffer(
  imageBuffer: Buffer,
  maxBytes: number,
  originalMediaType?: string,
): Promise<{ base64: string; mediaType: DetectedFormat; originalSize: number }> {
  const originalSize = imageBuffer.length
  const detected = detectImageFormatFromBuffer(imageBuffer)
  if (originalSize <= maxBytes) {
    return { base64: imageBuffer.toString('base64'), mediaType: detected, originalSize }
  }
  const sharp = await getImageProcessor()
  const format = normalizeSubtype(detected.replace('image/', '') || originalMediaType?.split('/')[1] || 'jpeg')
  const dims = await readDimensions(sharp, imageBuffer)
  const width = dims?.width ?? 2000
  const height = dims?.height ?? 2000
  const encode = async (target: { width: number; height: number } | null, encoding: Encoding): Promise<Buffer | null> => {
    try {
      return await attempt(sharp, imageBuffer, format, target, encoding)
    } catch (err) {
      logError(err)
      return null
    }
  }
  for (const scale of [1, 0.75, 0.5, 0.25]) {
    const target = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
    const output = await encode(target, format === 'png' ? { kind: 'png', palette: true } : format === 'webp' ? { kind: 'webp', quality: 80 } : { kind: 'jpeg', quality: 80 })
    if (output !== null && output.length <= maxBytes) return { base64: output.toString('base64'), mediaType: detectImageFormatFromBuffer(output), originalSize }
  }
  for (const [side, encoding] of [
    [800, { kind: 'png', palette: true } as Encoding],
    [600, { kind: 'jpeg', quality: 50 } as Encoding],
    [400, { kind: 'jpeg', quality: 20 } as Encoding],
  ] as const) {
    const output = await encode({ width: side, height: side }, encoding)
    if (output !== null && output.length <= maxBytes) return { base64: output.toString('base64'), mediaType: detectImageFormatFromBuffer(output), originalSize }
  }
  throw new ImageResizeError(
    `Image compression failed: the image is ${formatFileSize(originalSize)} and no encoding tried fit the ${formatFileSize(maxBytes)} read budget (the Read tool's token budget, not a provider limit). Supply a smaller image or a smaller budget.`,
  )
}

export async function compressImageBufferWithTokenLimit(
  imageBuffer: Buffer,
  maxTokens: number,
  originalMediaType?: string,
): Promise<{ base64: string; mediaType: DetectedFormat; originalSize: number }> {
  const maxBase64Chars = Math.floor(maxTokens / 0.125)
  const maxBytes = Math.floor(maxBase64Chars * 0.75)
  return compressImageBuffer(imageBuffer, maxBytes, originalMediaType)
}

export async function compressImageBlock(imageBlock: ImageBlockParam, maxBytes: number): Promise<ImageBlockParam> {
  if (imageBlock.source.type !== 'base64') return imageBlock
  const buffer = Buffer.from(imageBlock.source.data, 'base64')
  if (buffer.length <= maxBytes) return imageBlock
  const result = await compressImageBuffer(buffer, maxBytes)
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: result.mediaType as Base64ImageSource['media_type'],
      data: result.base64,
    },
  }
}


export function createImageMetadataText(dims: ImageDimensions, sourcePath?: string): string | null {
  const { originalWidth, originalHeight, displayWidth, displayHeight } = dims
  const complete =
    typeof originalWidth === 'number' &&
    originalWidth > 0 &&
    typeof originalHeight === 'number' &&
    originalHeight > 0 &&
    typeof displayWidth === 'number' &&
    displayWidth > 0 &&
    typeof displayHeight === 'number' &&
    displayHeight > 0
  if (!complete) return sourcePath ? `[Image source: ${sourcePath}]` : null
  const resized = originalWidth !== displayWidth || originalHeight !== displayHeight
  if (!resized && !sourcePath) return null
  const parts: string[] = []
  if (sourcePath) parts.push(`source: ${sourcePath}`)
  if (resized) {
    const scale = (originalWidth / displayWidth).toFixed(2)
    parts.push(`original dimensions: ${originalWidth}x${originalHeight}`)
    parts.push(`displayed at: ${displayWidth}x${displayHeight}`)
    parts.push(`multiply any coordinates you read off this image by ${scale} to map them onto the original`)
  }
  return `[Image: ${parts.join(', ')}]`
}

export function describeAttachedImage(dims: ImageDimensions | undefined, bytes: number): string {
  const size = formatFileSize(bytes)
  if (!dims?.originalWidth || !dims.originalHeight) return size
  const original = `${dims.originalWidth}x${dims.originalHeight}`
  if (dims.displayWidth && dims.displayHeight && (dims.displayWidth !== dims.originalWidth || dims.displayHeight !== dims.originalHeight)) {
    return `${original} shrunk to ${dims.displayWidth}x${dims.displayHeight} · ${size}`
  }
  return `${original} · ${size}`
}
