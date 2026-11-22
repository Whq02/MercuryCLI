import type { Message } from '../../types/message.js'
import type { ImageLimits } from '../../constants/apiLimits.js'
import { logForDebugging } from '../debug.js'
import { notBuilt } from '../../pi/holes.js'

export const IMAGE_ELIDED_TEXT = 'image elided from this request; Read it again if needed'

type ImageSlot = { parts: unknown[]; index: number; image: Record<string, unknown>; marker: Record<string, unknown> }

export function fitWireImages<T>(request: T, limits: Pick<ImageLimits, 'maxImagesPerRequest' | 'maxRequestBytes'>): { request: T; images: number; bytes: number; removed: number } {
  const slots: ImageSlot[] = []
  const walk = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) {
      const parts: unknown[] = []
      for (const item of value) {
        const block = item !== null && typeof item === 'object' ? item as Record<string, unknown> : undefined
        const image = block && (block.type === 'image' || block.type === 'input_image' || block.type === 'image_url' || (block.inlineData as { mimeType?: string } | undefined)?.mimeType?.startsWith('image/'))
        if (image && ['content', 'output', 'parts'].includes(key)) {
          slots.push({ parts, index: parts.length, image: block, marker: key === 'parts' ? { text: IMAGE_ELIDED_TEXT } : { type: block.type === 'input_image' ? 'input_text' : 'text', text: IMAGE_ELIDED_TEXT } })
          parts.push(block)
        } else parts.push(walk(item, key))
      }
      return parts
    }
    if (value === null || typeof value !== 'object') return value
    const row = value as Record<string, unknown>
    return Object.fromEntries(Object.entries(row).map(([name, child]) => [name, ['messages', 'input', 'contents', 'content', 'output', 'parts', 'request', 'functionResponse'].includes(name) ? walk(child, name) : child]))
  }
  const projected = walk(request) as T
  const before = Buffer.byteLength(JSON.stringify(request))
  let bytes = before
  let removed = 0
  for (const slot of slots) {
    if (slots.length - removed <= limits.maxImagesPerRequest && bytes <= limits.maxRequestBytes) break
    slot.parts[slot.index] = slot.marker
    bytes += Buffer.byteLength(JSON.stringify(slot.marker)) - Buffer.byteLength(JSON.stringify(slot.image))
    removed++
  }
  const result = removed === 0 ? request : projected
  bytes = removed === 0 ? before : Buffer.byteLength(JSON.stringify(result))
  if (slots.length > 0) logForDebugging(`request images: ${slots.length} before, ${slots.length - removed} sent; body bytes: ${before} before, ${bytes} sent; ${removed} images elided`)
  return { request: result, images: slots.length - removed, bytes, removed }
}

export function fitToolResultImages<M extends Message>(messages: M[], fits: (rows: M[]) => boolean): { messages: M[]; removed: number } {
  return notBuilt('src/utils/messages/imageRequestFit.ts:44')
}
