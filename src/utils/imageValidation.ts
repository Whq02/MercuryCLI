import { API_IMAGE_MAX_BASE64_SIZE } from '../constants/apiLimits.js'
import { formatFileSize } from './format.js'

/**
 * The last-chance API-boundary check that no image exceeds the provider's
 * BASE64 size cap (the string length, not the decoded length).
 */

export type OversizedImage = { index: number; size: number }

/** Consumers test class identity (`instanceof`). */
export class ImageSizeError extends Error {
  readonly oversizedImages: OversizedImage[]
  readonly limit: number

  constructor(oversizedImages: OversizedImage[], limit: number) {
    super(describe(oversizedImages, limit))
    this.name = 'ImageSizeError'
    this.oversizedImages = oversizedImages
    this.limit = limit
  }
}

function describe(oversized: OversizedImage[], limit: number): string {
  if (oversized.length === 1) {
    const only = oversized[0] as OversizedImage
    return `Image ${only.index} is ${formatFileSize(only.size)} as base64, which exceeds the ${formatFileSize(limit)} limit. Resize the image before sending it.`
  }
  const list = oversized.map(image => `image ${image.index}: ${formatFileSize(image.size)}`).join(', ')
  return `${oversized.length} images exceed the ${formatFileSize(limit)} limit (${list}). Resize the images before sending them.`
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

/** Only wrapped USER messages with an inner message object and an array body; images numbered from 1 across the whole list. */
export function validateImagesForAPI(messages: unknown[]): void {
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
      if (size > API_IMAGE_MAX_BASE64_SIZE) oversized.push({ index, size })
    }
  }
  if (oversized.length > 0) throw new ImageSizeError(oversized, API_IMAGE_MAX_BASE64_SIZE)
}
