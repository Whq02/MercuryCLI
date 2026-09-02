import { API_IMAGE_MAX_BASE64_SIZE, IMAGE_MAX_HEIGHT, IMAGE_MAX_WIDTH, IMAGE_TARGET_RAW_SIZE } from '../constants/apiLimits.js'
import { getImageProcessor, type SharpFunction, type SharpInstance } from '../tools/FileReadTool/imageProcessor.js'
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

const JPEG_QUALITY_LADDER = [80, 60, 40, 20] as const
const LAST_RESORT_WIDTH = 1000
const LAST_RESORT_QUALITY = 20


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

function pngHeaderOverDimension(buffer: Buffer): boolean {
  if (buffer.length < 24) return false
  if (detectImageFormatFromBuffer(buffer) !== 'image/png') return false
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return width > IMAGE_MAX_WIDTH || height > IMAGE_MAX_HEIGHT
}

function normalizeSubtype(name: string): string {
  return name === 'jpg' ? 'jpeg' : name
}

function fitInside(sharp: SharpFunction, buffer: Buffer, width: number, height: number): SharpInstance {
  return sharp(buffer).resize(width, height, { fit: 'inside', withoutEnlargement: true })
}


export async function maybeResizeAndDownsampleImageBuffer(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
): Promise<ResizeResult> {
  if (imageBuffer.length === 0) {
    throw new ImageResizeError('Image resizing failed: the image buffer is empty.')
  }
  try {
    const sharp = await getImageProcessor()
    const metadata = await sharp(imageBuffer).metadata()
    const mediaType = normalizeSubtype(metadata.format || ext)

    if (!metadata.width || !metadata.height) {
      if (originalSize > IMAGE_TARGET_RAW_SIZE) {
        const jpeg = await sharp(imageBuffer).jpeg({ quality: 80 }).toBuffer()
        return { buffer: jpeg, mediaType: 'jpeg' }
      }
      return { buffer: imageBuffer, mediaType }
    }

    const width = metadata.width
    const height = metadata.height
    const inBounds = width <= IMAGE_MAX_WIDTH && height <= IMAGE_MAX_HEIGHT
    const unchanged: ImageDimensions = { originalWidth: width, originalHeight: height, displayWidth: width, displayHeight: height }

    if (originalSize <= IMAGE_TARGET_RAW_SIZE && inBounds) {
      return { buffer: imageBuffer, mediaType, dimensions: unchanged }
    }

    if (inBounds) {
      if (mediaType === 'png') {
        const png = await sharp(imageBuffer).png({ compressionLevel: 9, palette: true }).toBuffer()
        if (png.length <= IMAGE_TARGET_RAW_SIZE) return { buffer: png, mediaType: 'png', dimensions: unchanged }
      }
      for (const quality of JPEG_QUALITY_LADDER) {
        const jpeg = await sharp(imageBuffer).jpeg({ quality }).toBuffer()
        if (jpeg.length <= IMAGE_TARGET_RAW_SIZE) return { buffer: jpeg, mediaType: 'jpeg', dimensions: unchanged }
      }
    }

    let targetWidth = width
    let targetHeight = height
    if (targetWidth > IMAGE_MAX_WIDTH) {
      targetHeight = Math.round((targetHeight * IMAGE_MAX_WIDTH) / targetWidth)
      targetWidth = IMAGE_MAX_WIDTH
    }
    if (targetHeight > IMAGE_MAX_HEIGHT) {
      targetWidth = Math.round((targetWidth * IMAGE_MAX_HEIGHT) / targetHeight)
      targetHeight = IMAGE_MAX_HEIGHT
    }
    const resizedDimensions: ImageDimensions = {
      originalWidth: width,
      originalHeight: height,
      displayWidth: targetWidth,
      displayHeight: targetHeight,
    }
    const resized = await fitInside(sharp, imageBuffer, targetWidth, targetHeight).toBuffer()
    if (resized.length <= IMAGE_TARGET_RAW_SIZE) return { buffer: resized, mediaType, dimensions: resizedDimensions }

    if (mediaType === 'png') {
      const png = await fitInside(sharp, imageBuffer, targetWidth, targetHeight)
        .png({ compressionLevel: 9, palette: true })
        .toBuffer()
      if (png.length <= IMAGE_TARGET_RAW_SIZE) return { buffer: png, mediaType: 'png', dimensions: resizedDimensions }
    }
    for (const quality of JPEG_QUALITY_LADDER) {
      const jpeg = await fitInside(sharp, imageBuffer, targetWidth, targetHeight).jpeg({ quality }).toBuffer()
      if (jpeg.length <= IMAGE_TARGET_RAW_SIZE) return { buffer: jpeg, mediaType: 'jpeg', dimensions: resizedDimensions }
    }

    const lastWidth = Math.min(width, LAST_RESORT_WIDTH)
    const lastHeight = width > 0 ? Math.round((height * lastWidth) / width) : height
    const last = await fitInside(sharp, imageBuffer, lastWidth, lastHeight).jpeg({ quality: LAST_RESORT_QUALITY }).toBuffer()
    return {
      buffer: last,
      mediaType: 'jpeg',
      dimensions: { originalWidth: width, originalHeight: height, displayWidth: lastWidth, displayHeight: lastHeight },
    }
  } catch (err) {
    logError(err)
    const base64Length = Math.ceil((originalSize * 4) / 3)
    const overDimension = pngHeaderOverDimension(imageBuffer)
    if (base64Length <= API_IMAGE_MAX_BASE64_SIZE && !overDimension) {
      return { buffer: imageBuffer, mediaType: detectImageFormatFromBuffer(imageBuffer).replace('image/', '') }
    }
    if (overDimension) {
      throw new ImageResizeError(
        `Image resizing failed and the image dimensions exceed the ${IMAGE_MAX_WIDTH}x${IMAGE_MAX_HEIGHT} pixel limit. Reduce the image's pixel dimensions and try again.`,
      )
    }
    throw new ImageResizeError(
      `Image resizing failed: the image is ${formatFileSize(originalSize)} (${formatFileSize(base64Length)} as base64) and exceeds the ${formatFileSize(API_IMAGE_MAX_BASE64_SIZE)} limit. Resize the image or supply a smaller one.`,
    )
  }
}


export async function maybeResizeAndDownsampleImageBlock(imageBlock: ImageBlockParam): Promise<ImageBlockWithDimensions> {
  if (imageBlock.source.type !== 'base64') return { block: imageBlock }
  const buffer = Buffer.from(imageBlock.source.data, 'base64')
  const ext = imageBlock.source.media_type?.split('/')[1] || 'png'
  const result = await maybeResizeAndDownsampleImageBuffer(buffer, buffer.length, ext)
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

export async function clampToolResultImageBlocks(block: { type: string; content?: unknown }): Promise<void> {
  if (block.type !== 'tool_result' || !Array.isArray(block.content)) return
  const parts = block.content as unknown[]
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as { type?: string; source?: { type?: string } } | null
    if (!part || part.type !== 'image' || part.source?.type !== 'base64') continue
    try {
      const resized = await maybeResizeAndDownsampleImageBlock(part as ImageBlockParam)
      parts[index] = resized.block
    } catch {
    }
  }
}


export async function compressImageBuffer(
  imageBuffer: Buffer,
  maxBytes: number = IMAGE_TARGET_RAW_SIZE,
  originalMediaType?: string,
): Promise<{ base64: string; mediaType: DetectedFormat; originalSize: number }> {
  const originalSize = imageBuffer.length
  try {
    const sharp = await getImageProcessor()
    const metadata = await sharp(imageBuffer).metadata()
    const format = normalizeSubtype(metadata.format || originalMediaType?.split('/')[1] || 'jpeg')
    if (originalSize <= maxBytes) {
      return { base64: imageBuffer.toString('base64'), mediaType: `image/${format}` as DetectedFormat, originalSize }
    }
    const width = metadata.width || 2000
    const height = metadata.height || 2000
    for (const scale of [1, 0.75, 0.5, 0.25]) {
      let handle = fitInside(sharp, imageBuffer, Math.round(width * scale), Math.round(height * scale))
      if (format === 'png') handle = handle.png({ compressionLevel: 9, palette: true })
      else if (format === 'jpeg') handle = handle.jpeg({ quality: 80 })
      else if (format === 'webp') handle = handle.webp({ quality: 80 })
      const output = await handle.toBuffer()
      if (output.length <= maxBytes) return { base64: output.toString('base64'), mediaType: `image/${format}` as DetectedFormat, originalSize }
    }
    if (format === 'png') {
      const palette = await fitInside(sharp, imageBuffer, 800, 800).png({ compressionLevel: 9, palette: true, colors: 64 }).toBuffer()
      if (palette.length <= maxBytes) return { base64: palette.toString('base64'), mediaType: 'image/png', originalSize }
    }
    const jpeg = await fitInside(sharp, imageBuffer, 600, 600).jpeg({ quality: 50 }).toBuffer()
    if (jpeg.length <= maxBytes) return { base64: jpeg.toString('base64'), mediaType: 'image/jpeg', originalSize }
    const last = await fitInside(sharp, imageBuffer, 400, 400).jpeg({ quality: 20 }).toBuffer()
    return { base64: last.toString('base64'), mediaType: 'image/jpeg', originalSize }
  } catch (err) {
    if (originalSize <= maxBytes) {
      return { base64: imageBuffer.toString('base64'), mediaType: detectImageFormatFromBuffer(imageBuffer), originalSize }
    }
    logError(err)
    throw new ImageResizeError(
      `Image compression failed: the image is ${formatFileSize(originalSize)} and exceeds the ${formatFileSize(maxBytes)} budget. Supply a smaller image.`,
    )
  }
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

export async function compressImageBlock(imageBlock: ImageBlockParam, maxBytes: number = IMAGE_TARGET_RAW_SIZE): Promise<ImageBlockParam> {
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
