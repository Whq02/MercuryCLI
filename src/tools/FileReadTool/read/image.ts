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
import { notBuilt } from '../../../pi/holes.js'

const IMAGE_TOKEN_BUDGET_DEFAULT = 25000
const IMAGE_CAPTION_OCR_CEILING_MS = 3_000

type ImageOutput = Extract<Output, { type: 'image' }>

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
  return notBuilt('src/tools/FileReadTool/read/image.ts:43')
}

export function imageReadCaptions(
  resolvedPath: string,
  dimensions: ImageDimensions | undefined,
  cropped: { box: CropBox; asked?: CropBox; full: { width: number; height: number } } | undefined,
  scale?: number,
): string[] {
  return notBuilt('src/tools/FileReadTool/read/image.ts:132')
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
