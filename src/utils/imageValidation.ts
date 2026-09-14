import { GENERIC_IMAGE_LIMITS, type ImageLimits } from '../constants/apiLimits.js'
import { imageDimensionsFromHeader } from '../tools/FileReadTool/imageProcessorJs.js'
import { formatFileSize } from './format.js'
import { imageLimitsForModel, patchCountOf } from './imageResizer.js'
import { getMainLoopModel } from './model/model.js'


export type ImageRule = 'bytes' | 'patches' | 'request'

export type OversizedImage = { index: number; size: number; width?: number; height?: number; patches?: number; patchPx?: number }

export class ImageSizeError extends Error {
  readonly oversizedImages: OversizedImage[]
  readonly limit: number
  readonly rule: ImageRule

  constructor(oversizedImages: OversizedImage[], limit: number, family?: string, rule: ImageRule = 'bytes') {
    super(describe(oversizedImages, limit, family, rule))
    this.name = 'ImageSizeError'
    this.oversizedImages = oversizedImages
    this.limit = limit
    this.rule = rule
  }
}

function limitPhrase(limit: number, family: string | undefined, rule: ImageRule): string {
  if (rule === 'patches') return `${family ?? 'the provider'}'s ${limit.toLocaleString('en-US')}-patch per-image limit`
  if (rule === 'request') return `${family ?? 'the provider'}'s ${formatFileSize(limit)} per-request limit`
  return family ? `${family}'s ${formatFileSize(limit)} per-image limit` : `the ${formatFileSize(limit)} limit`
}

function describe(oversized: OversizedImage[], limit: number, family: string | undefined, rule: ImageRule): string {
  const whose = limitPhrase(limit, family, rule)
  if (rule === 'request') {
    const total = oversized.reduce((sum, image) => sum + image.size, 0)
    const count = oversized.length === 1 ? 'The one image is' : `${oversized.length} images total`
    return `${count} ${formatFileSize(total)} as base64, which exceeds ${whose}. Remove or resize images before sending them.`
  }
  const sizeOf = (image: OversizedImage): string =>
    rule === 'patches'
      ? `${image.width}x${image.height} px (${(image.patches ?? 0).toLocaleString('en-US')} patches of ${image.patchPx} px)`
      : `${formatFileSize(image.size)}${rule === 'bytes' ? ' as base64' : ''}`
  if (oversized.length === 1) {
    const only = oversized[0] as OversizedImage
    return `Image ${only.index} is ${sizeOf(only)}, which exceeds ${whose}. Resize the image before sending it.`
  }
  const list = oversized.map(image => `image ${image.index}: ${rule === 'patches' ? sizeOf(image) : formatFileSize(image.size)}`).join(', ')
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

const HEADER_PREFIX_CHARS = 96 * 1024

function dimensionsOfBase64(data: string): { width: number; height: number } | null {
  const head = imageDimensionsFromHeader(Buffer.from(data.length > HEADER_PREFIX_CHARS ? data.slice(0, HEADER_PREFIX_CHARS) : data, 'base64'))
  if (head !== null || data.length <= HEADER_PREFIX_CHARS) return head
  return imageDimensionsFromHeader(Buffer.from(data, 'base64'))
}

function limitsForRequest(model: string | undefined): { limits: ImageLimits; family: string | undefined } {
  try {
    const limits = imageLimitsForModel(model ?? getMainLoopModel())
    return { limits, family: limits.family === 'generic' ? undefined : limits.family }
  } catch {
    return { limits: GENERIC_IMAGE_LIMITS, family: undefined }
  }
}

export function findOversizedImages(
  messages: unknown[],
  limits: ImageLimits,
): { rule: ImageRule; limit: number; oversized: OversizedImage[] } | null {
  const images: Array<{ index: number; data: string }> = []
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
      images.push({ index, data: block.source.data })
    }
  }
  if (images.length === 0) return null
  if (limits.maxBase64Bytes !== null) {
    const cap = limits.maxBase64Bytes
    const oversized = images.filter(image => image.data.length > cap).map(image => ({ index: image.index, size: image.data.length }))
    if (oversized.length > 0) return { rule: 'bytes', limit: cap, oversized }
  }
  if (limits.maxPatchesPerImage !== null) {
    const { patchPx, count } = limits.maxPatchesPerImage
    const oversized: OversizedImage[] = []
    for (const image of images) {
      const dims = dimensionsOfBase64(image.data)
      if (dims === null) continue
      const patches = patchCountOf(dims.width, dims.height, patchPx)
      if (patches > count) oversized.push({ index: image.index, size: image.data.length, width: dims.width, height: dims.height, patches, patchPx })
    }
    if (oversized.length > 0) return { rule: 'patches', limit: count, oversized }
  }
  if (limits.maxBase64Bytes === null) {
    const total = images.reduce((sum, image) => sum + image.data.length, 0)
    if (total > limits.maxRequestBytes) {
      return { rule: 'request', limit: limits.maxRequestBytes, oversized: images.map(image => ({ index: image.index, size: image.data.length })) }
    }
  }
  return null
}

export function validateImagesForAPI(messages: unknown[], model?: string): void {
  const { limits, family } = limitsForRequest(model)
  const found = findOversizedImages(messages, limits)
  if (found !== null) throw new ImageSizeError(found.oversized, found.limit, family, found.rule)
}
