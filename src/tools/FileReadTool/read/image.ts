import type { ToolUseContext } from '../../../Tool.js'
import { isRemotePath } from '../../../utils/remoteFiles/target.js'
import { compressImageBufferWithTokenLimit, createImageMetadataText, detectImageFormatFromBuffer, ImageResizeError, maybeResizeAndDownsampleImageBuffer, type ImageDimensions } from '../../../utils/imageResizer.js'
import { logError } from '../../../utils/log.js'
import { recogniseImage, renderOcr } from '../../../services/ocr.js'
import { readRegularFileSync } from '../../../utils/regularFile.js'
import type { FileReadingLimits } from '../../../utils/fileReadLimits.js'
import type { Output, CropBox, LaneResult } from './schema.js'
import { passedOver } from '../../../utils/passedOver.js'
import { createChildAbortController } from '../../../utils/abortController.js'
import { withDeadline } from '../../../utils/deadline.js'
import { getImageProcessor } from '../../../utils/imageProcessor/imageProcessor.js'
import { notBuilt } from '../../../pi/holes.js'

const IMAGE_TOKEN_BUDGET_DEFAULT = 25000
const IMAGE_CAPTION_OCR_CEILING_MS = 3_000

type ImageOutput = Extract<Output, { type: 'image' }>

function toImageMime(mediaType: string): ImageOutput['file']['type'] {
  const normalized = mediaType.startsWith('image/') ? mediaType : `image/${mediaType}`
  switch (normalized) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'image/jpeg'
    case 'image/png':
      return 'image/png'
    case 'image/gif':
      return 'image/gif'
    case 'image/webp':
      return 'image/webp'
    default:
      return 'image/png'
  }
}

export async function cropImageBuffer(buffer: Buffer, crop: CropBox, filePath: string, scale?: number): Promise<{ buffer: Buffer; full: { width: number; height: number }; box: CropBox }> {
  return notBuilt('src/tools/FileReadTool/read/image.ts:18')
}

export async function readImageWithTokenBudget(
  filePath: string,
  maxTokens?: number,
  maxBytes?: number,
  crop?: CropBox,
  scale?: number,
): Promise<ImageOutput & { cropped?: { box: CropBox; asked?: CropBox; full: { width: number; height: number } } }> {
  const rawBuffer = readRegularFileSync(filePath)
  if (rawBuffer.length === 0) {
    throw new Error(`Empty image file (zero bytes): ${filePath}`)
  }
  const originalSize = rawBuffer.length
  let buffer = rawBuffer
  let cropped: { box: CropBox; asked?: CropBox; full: { width: number; height: number } } | undefined
  if (crop !== undefined) {
    const cut = await cropImageBuffer(buffer, crop, filePath, scale)
    buffer = cut.buffer
    const clamped =
      cut.box[0] !== crop[0] ||
      cut.box[1] !== crop[1] ||
      cut.box[2] !== crop[2] ||
      cut.box[3] !== crop[3]
    cropped = {
      box: cut.box,
      ...(clamped ? { asked: crop } : {}),
      full: cut.full,
    }
  }
  const detected = detectImageFormatFromBuffer(buffer)
  const ext = detected.slice('image/'.length)
  let resized: { buffer: Buffer; mediaType: string; dimensions?: ImageDimensions }
  try {
    resized = await maybeResizeAndDownsampleImageBuffer(buffer, buffer.length, ext)
  } catch (error) {
    if (error instanceof ImageResizeError) throw error
    logError(error)
    resized = { buffer, mediaType: ext }
  }
  const base64 = resized.buffer.toString('base64')
  const resizedMime = toImageMime(resized.mediaType)
  const tokenBudget = maxTokens ?? IMAGE_TOKEN_BUDGET_DEFAULT
  const estimatedTokens = Math.ceil(base64.length * 0.125)
  const withinTokens = estimatedTokens <= tokenBudget
  const withinBytes = maxBytes === undefined || resized.buffer.length <= maxBytes
  if (withinTokens && withinBytes) {
    return {
      type: 'image',
      file: {
        base64,
        type: resizedMime,
        originalSize,
        ...(resized.dimensions !== undefined ? { dimensions: resized.dimensions } : {}),
      },
      ...(cropped !== undefined ? { cropped } : {}),
    }
  }
  const effectiveMaxTokens =
    maxBytes !== undefined
      ? Math.min(tokenBudget, Math.floor(Math.ceil(maxBytes / 3) * 4 * 0.125))
      : tokenBudget
  try {
    const compressed = await compressImageBufferWithTokenLimit(buffer, effectiveMaxTokens, detected)
    return {
      type: 'image',
      file: {
        base64: compressed.base64,
        type: compressed.mediaType,
        originalSize,
      },
      ...(cropped !== undefined ? { cropped } : {}),
    }
  } catch (error) {
    passedOver(error)
  }
  try {
    const sharp = await getImageProcessor()
    const fallback = await sharp(buffer)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 20 })
      .toBuffer()
    return {
      type: 'image',
      file: {
        base64: fallback.toString('base64'),
        type: detectImageFormatFromBuffer(fallback),
        originalSize,
      },
      ...(cropped !== undefined ? { cropped } : {}),
    }
  } catch (fallbackError) {
    passedOver(fallbackError)
    return {
      type: 'image',
      file: {
        base64,
        type: resizedMime,
        originalSize,
        ...(resized.dimensions !== undefined ? { dimensions: resized.dimensions } : {}),
      },
      ...(cropped !== undefined ? { cropped } : {}),
    }
  }
}

export function imageReadCaptions(
  resolvedPath: string,
  dimensions: ImageDimensions | undefined,
  cropped: { box: CropBox; asked?: CropBox; full: { width: number; height: number } } | undefined,
  scale?: number,
): string[] {
  const captions: string[] = []
  if (cropped !== undefined) {
    const clampedNote =
      cropped.asked !== undefined
        ? ` (the box asked for, [${cropped.asked.join(', ')}], passed the image's edge and was cut to it)`
        : ''
    const scaleNote = scale !== undefined && scale > 1 ? ` and scaled by ${scale}` : ''
    captions.push(
      `This image is the crop [${cropped.box.join(', ')}] of ${resolvedPath}${clampedNote}, cut from the ${cropped.full.width}x${cropped.full.height} px original before any downscale${scaleNote}; the coordinates below are the crop's own.`,
    )
  }
  if (dimensions !== undefined) {
    const meta = createImageMetadataText(dimensions, resolvedPath)
    if (meta) captions.push(meta)
  }
  return captions
}

export async function recogniseImageCaption(bytes: Buffer, parent: AbortController): Promise<string | null> {
  const reading = createChildAbortController(parent)
  try {
    const ocr = await withDeadline(
      recogniseImage(bytes, reading.signal).catch(error => {
        if (parent.signal.aborted) throw error
        passedOver(error)
        return null
      }),
      IMAGE_CAPTION_OCR_CEILING_MS,
      () => null,
      { signal: parent.signal },
    )
    return ocr && ocr.ok && ocr.text.trim() ? renderOcr(ocr) : null
  } finally {
    reading.abort()
  }
}

export async function readImageLane(
  resolvedPath: string,
  keyPath: string,
  context: ToolUseContext,
  limits: FileReadingLimits,
  crop?: CropBox,
  scale = 1,
): Promise<LaneResult> {
  const { cropped, ...data } = await readImageWithTokenBudget(resolvedPath, limits.maxTokens, undefined, crop, scale)
  if (!isRemotePath(keyPath)) context.nestedMemoryAttachmentTriggers?.add(keyPath)
  const captions = imageReadCaptions(resolvedPath, data.file.dimensions, cropped, scale)
  const ocr = await recogniseImageCaption(Buffer.from(data.file.base64, 'base64'), context.abortController)
  if (ocr !== null) captions.push(ocr)
  if (captions.length) data.file.caption = captions.join('\n')
  return { data }
}
