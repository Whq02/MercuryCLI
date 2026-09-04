import { STRICTEST_IMAGE_MAX_BASE64_BYTES } from '../constants/apiLimits.js'
import { formatFileSize } from './format.js'
import { imageLimitsForModel } from './imageResizer.js'
import { getMainLoopModel } from './model/model.js'


export type OversizedImage = { index: number; size: number }

export class ImageSizeError extends Error {
  readonly oversizedImages: OversizedImage[]
  readonly limit: number

  constructor(oversizedImages: OversizedImage[], limit: number, family?: string) {
    super(describe(oversizedImages, limit, family))
    this.name = 'ImageSizeError'
    this.oversizedImages = oversizedImages
    this.limit = limit
  }
}

function describe(oversized: OversizedImage[], limit: number, family?: string): string {
  const whose = family ? `${family}'s ${formatFileSize(limit)} per-image limit` : `the ${formatFileSize(limit)} limit`
  if (oversized.length === 1) {
    const only = oversized[0] as OversizedImage
    return `Image ${only.index} is ${formatFileSize(only.size)} as base64, which exceeds ${whose}. Resize the image before sending it.`
  }
  const list = oversized.map(image => `image ${image.index}: ${formatFileSize(image.size)}`).join(', ')
  return `${oversized.length} images exceed ${whose} (${list}). Resize the images before sending them.`
}

function isBase64ImageBlock(block: unknown): block is { type: 'image'; source: { type: 'base64'; data: string } } {
  if (!block || typeof block !== 'object') return false
  const candidate = block as { type?: unknown; source?: { type?: unknown; data?: unknown } }
  return (
    candidate.type === 'image' &&
    !!candidate.source &&
    typeof candidate.source === 'object' &&
    candidate.source.type === 'base64' &&
    typeof candidate.source.data === 'string'
  )
}

function ceilingForRequest(model: string | undefined): { limit: number; family: string | undefined } {
  try {
    const limits = imageLimitsForModel(model ?? getMainLoopModel())
    return { limit: limits.maxBase64Bytes, family: limits.family === 'generic' ? undefined : limits.family }
  } catch {
    return { limit: STRICTEST_IMAGE_MAX_BASE64_BYTES, family: undefined }
  }
}

export function validateImagesForAPI(messages: unknown[], model?: string): void {
  const { limit, family } = ceilingForRequest(model)
  const oversized: OversizedImage[] = []
  let index = 0
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue
    const wrapped = entry as { type?: unknown; message?: { content?: unknown } | null }
    if (wrapped.type !== 'user' || !wrapped.message || typeof wrapped.message !== 'object') continue
    const content = wrapped.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isBase64ImageBlock(block)) continue
      index++
      const size = block.source.data.length
      if (size > limit) oversized.push({ index, size })
    }
  }
  if (oversized.length > 0) throw new ImageSizeError(oversized, limit, family)
}
