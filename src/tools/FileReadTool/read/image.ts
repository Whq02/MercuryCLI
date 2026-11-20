import type { ToolUseContext } from '../../../Tool.js'
import { isRemotePath } from '../../../utils/remoteFiles/target.js'
import { compressImageBufferWithTokenLimit, createImageMetadataText, detectImageFormatFromBuffer, ImageResizeError, maybeResizeAndDownsampleImageBuffer, type ImageDimensions } from '../../../utils/imageResizer.js'
import { logError } from '../../../utils/log.js'
import { recogniseImage, renderOcr } from '../../../utils/ocr.js'
import { readRegularFileSync } from '../../../utils/regularFile.js'
import type { FileReadingLimits } from '../../../utils/fileReadLimits.js'
import type { Output, CropBox, LaneResult } from './schema.js'
import { passedOver } from '../../../utils/passedOver.js'

const IMAGE_TOKEN_BUDGET_DEFAULT = 25000

type ImageOutput = Extract<Output, { type: 'image' }>

export async function cropImageBuffer(buffer: Buffer, crop: CropBox, filePath: string, scale = 1): Promise<{ buffer: Buffer; full: { width: number; height: number }; box: CropBox }> {
  const [x1, y1] = crop
  const box = `[${crop.join(', ')}]`
  if (crop.length !== 4 || crop.some(value => !Number.isInteger(value) || value < 0)) throw new Error(`crop refused: ${box} must be four non-negative integers in the image's own pixels (x1, y1, x2, y2)`)
  if (crop[2] <= x1 || crop[3] <= y1) throw new Error(`crop refused: ${box} is inverted or empty — x2 must exceed x1 and y2 must exceed y1`)
  const { getImageProcessor } = await import('../imageProcessor.js')
  const { imageDimensionsFromHeader } = await import('../imageProcessorJs.js')
  const sharp = await getImageProcessor()
  const metadata = await sharp(buffer).metadata().catch((error) => { passedOver(error); return ({}) as { width?: number; height?: number } })
  const header = imageDimensionsFromHeader(buffer)
  const width = metadata.width ?? header?.width
  const height = metadata.height ?? header?.height
  if (width === undefined || height === undefined) throw new Error(`crop refused: the size of ${filePath} could not be read, so ${box} cannot be checked against it`)
  if (x1 >= width || y1 >= height) throw new Error(`crop refused: ${box} reaches outside the image, which is ${width}x${height} px`)
  const x2 = Math.min(crop[2], width)
  const y2 = Math.min(crop[3], height)
  if (!Number.isFinite(scale) || scale < 1) throw new Error('scale must be a finite number of at least 1.')
  const cropWidth = x2 - x1
  const cropHeight = y2 - y1
  let processor = sharp(buffer).extract({ left: x1, top: y1, width: cropWidth, height: cropHeight })
  if (scale !== 1) processor = processor.resize(Math.round(cropWidth * scale), Math.round(cropHeight * scale), { fit: 'fill', withoutEnlargement: false, ...(Number.isInteger(scale) ? { kernel: 'nearest' } : {}) })
  const cropped = await processor.png({ compressionLevel: 6 }).toBuffer()
  return { buffer: cropped, full: { width, height }, box: [x1, y1, x2, y2] }
}

export async function readImageWithTokenBudget(
  filePath: string,
  maxTokens: number = IMAGE_TOKEN_BUDGET_DEFAULT,
  maxBytes?: number,
  crop?: CropBox,
  scale = 1,
): Promise<ImageOutput & { cropped?: { box: CropBox; asked?: CropBox; full: { width: number; height: number } } }> {
  const file = readRegularFileSync(filePath)
  if (file.length === 0) {
    throw new Error(`Empty image file (zero bytes): ${filePath}`)
  }
  const cut = crop === undefined ? null : await cropImageBuffer(file, crop, filePath, scale)
  const buffer = cut === null ? file : cut.buffer
  const detected = detectImageFormatFromBuffer(buffer)
  const detectedSubtype = detected.split('/')[1] || 'png'
  const cutShort = cut !== null && crop !== undefined && (cut.box[2] !== crop[2] || cut.box[3] !== crop[3])
  const cropped = cut === null || crop === undefined ? {} : { cropped: { box: cut.box, ...(cutShort ? { asked: crop } : {}), full: cut.full } }

  let resized: { buffer: Buffer; mediaType: string; dimensions?: ImageDimensions }
  try {
    resized = await maybeResizeAndDownsampleImageBuffer(buffer, buffer.length, detectedSubtype)
  } catch (err) {
    if (err instanceof ImageResizeError) throw err
    logError(err)
    resized = { buffer, mediaType: detectedSubtype }
  }

  const base64 = resized.buffer.toString('base64')
  const estimatedTokens = Math.ceil(base64.length / 8)
  const overTokenBudget = estimatedTokens > maxTokens
  const overByteBudget = maxBytes !== undefined && resized.buffer.length > maxBytes

  if (!overTokenBudget && !overByteBudget) {
    return {
      type: 'image',
      file: {
        base64,
        type: `image/${resized.mediaType}` as ImageOutput['file']['type'],
        originalSize: buffer.length,
        ...(resized.dimensions ? { dimensions: resized.dimensions } : {}),
      },
      ...cropped,
    }
  }

  try {
    const compressed = await compressImageBufferWithTokenLimit(resized.buffer, maxTokens, `image/${resized.mediaType}`)
    return {
      type: 'image',
      file: {
        base64: compressed.base64,
        type: compressed.mediaType as ImageOutput['file']['type'],
        originalSize: buffer.length,
      },
      ...cropped,
    }
  } catch (err) {
    logError(err)
  }
  try {
    const { getImageProcessor } = await import('../imageProcessor.js')
    const sharp = await getImageProcessor()
    const lastResort = await sharp(buffer)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 20 })
      .toBuffer()
    return {
      type: 'image',
      file: {
        base64: lastResort.toString('base64'),
        type: detectImageFormatFromBuffer(lastResort) as ImageOutput['file']['type'],
        originalSize: buffer.length,
      },
      ...cropped,
    }
  } catch (err) {
    logError(err)
    return {
      type: 'image',
      file: {
        base64,
        type: `image/${resized.mediaType}` as ImageOutput['file']['type'],
        originalSize: buffer.length,
      },
      ...cropped,
    }
  }
}

export function imageReadCaptions(
  resolvedPath: string,
  dimensions: ImageDimensions | undefined,
  cropped: { box: CropBox; asked?: CropBox; full: { width: number; height: number } } | undefined,
  scale = 1,
): string[] {
  const captions: string[] = []
  if (cropped !== undefined) {
    captions.push(`This image is the crop [${cropped.box.join(', ')}] of ${resolvedPath}${cropped.asked === undefined ? '' : ` (the box asked for, [${cropped.asked.join(', ')}], passed the image's edge and was cut to it)`}, cut from the ${cropped.full.width}x${cropped.full.height} px original before any downscale${scale === 1 ? '' : ` and scaled by ${scale}`}; the coordinates below are the crop's own.`)
  }
  if (dimensions) {
    const metadataText = createImageMetadataText(dimensions, resolvedPath)
    if (metadataText) captions.push(metadataText)
  }
  return captions
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
  const ocr = await recogniseImage(Buffer.from(data.file.base64, 'base64'), context.abortController.signal)
  if (ocr.ok && ocr.text.trim()) captions.push(renderOcr(ocr))
  if (captions.length) data.file.caption = captions.join('\n')
  return { data }
}
