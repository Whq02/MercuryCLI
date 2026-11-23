import { createHash } from 'node:crypto'
import {
  IMAGE_LIMITS_BY_FAMILY,
  type ImageLimitFamily,
  type ImageLimits,
} from '../constants/apiLimits.js'
import type { CallModelRoute } from '../types/providerRoute.js'
import { providerCapabilities } from './model/capabilityRegistry.js'
import { getImageProcessor, imageProcessorState, type SharpFunction } from './imageProcessor/imageProcessor.js'
import { imageDimensionsFromHeader } from './imageProcessor/imageProcessorJs.js'
import type { Base64ImageSource, ImageBlockParam, ToolResultBlockParam } from '../types/wire.js'
import { logForDebugging } from './debug.js'
import { formatFileSize } from './format.js'
import { conversationEditKey, settleWireEdits, type WireEdit } from './messages/wireEdits.js'
import { passedOver } from './passedOver.js'


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

type ResizeResult = {
  buffer: Buffer
  mediaType: string
  dimensions?: ImageDimensions
}

type ImageBlockWithDimensions = { block: ImageBlockParam; dimensions?: ImageDimensions }

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

export function imageLimitsForModel(model: string | undefined, route?: CallModelRoute): ImageLimits {
  if (route !== undefined) return IMAGE_LIMITS_BY_FAMILY[imageLimitFamilyForRoute(route)]
  if (model === undefined || model.trim() === '') return IMAGE_LIMITS_BY_FAMILY.generic
  const verdict = providerCapabilities().classifyModelRoute(model)
  return IMAGE_LIMITS_BY_FAMILY[imageLimitFamilyForRoute(verdict.kind === 'route' ? verdict.route : undefined)]
}

export function anthropicResolutionTier(model: string | undefined): 'standard' | 'highResolution' {
  const match = /^claude-(?:[a-z]+-)*(\d+)(?:[-.](\d+))?/.exec(model ?? '')
  if (match === null) return 'standard'
  const major = Number(match[1])
  const minor = match[2] === undefined ? 0 : Number(match[2])
  return major > 4 || (major === 4 && minor >= 7) ? 'highResolution' : 'standard'
}

async function engineModel(): Promise<string | undefined> {
  const caps = providerCapabilities()
  try {
    return caps.getEngineModel()
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

type Caps = {
  limits: ImageLimits
  sidePx: number | null
  longEdgePx: number | null
  patches: ImageLimits['maxPatchesPerImage']
  rawBytes: number
}

export function patchCountOf(width: number, height: number, patchPx: number): number {
  return Math.ceil(width / patchPx) * Math.ceil(height / patchPx)
}

function base64LengthOf(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4
}

export function statedManyImageLimit(sentence: string): number | null {
  const at = sentence.search(/many[- ]images?/i)
  if (at === -1) return null
  const tail = sentence.slice(at)
  const stated = />\s*(\d{3,5})(?:\s*x\s*(\d{3,5}))?\s*(?:px|pixels)\b/i.exec(tail) ?? /:\s*(\d{3,5})\s*(?:px|pixels)\b/i.exec(tail)
  if (stated === null) return null
  return stated[2] === undefined ? Number(stated[1]) : Math.min(Number(stated[1]), Number(stated[2]))
}

export function manyImageLimitStatedIn(messages: readonly unknown[]): number | null {
  let lowest: number | null = null
  for (const row of messages) {
    const record = row as { type?: unknown; isApiErrorMessage?: unknown; errorDetails?: unknown } | null
    if (record === null || record.type !== 'assistant' || record.isApiErrorMessage !== true || typeof record.errorDetails !== 'string') continue
    const stated = statedManyImageLimit(record.errorDetails)
    if (stated !== null && (lowest === null || stated < lowest)) lowest = stated
  }
  return lowest
}

export function requestImageSidePx(limits: ImageLimits, imagesInRequest: number, statedSidePx?: number | null): number | null {
  const many = limits.manyImages
  if (many === null) return limits.maxSidePx
  if (!many.fromFirstSend && imagesInRequest <= many.threshold) return limits.maxSidePx
  const bound = statedSidePx !== null && statedSidePx !== undefined ? Math.min(many.maxSidePx, statedSidePx) : many.maxSidePx
  return limits.maxSidePx === null ? bound : Math.min(limits.maxSidePx, bound)
}

async function resolveCaps(options: ResizeOptions | undefined): Promise<Caps> {
  const model = options?.model ?? (options?.limits === undefined || options?.role === 'tool-result' ? await engineModel() : undefined)
  const limits = options?.limits ?? imageLimitsForModel(model)
  const sidePx = requestImageSidePx(limits, options?.imagesInRequest ?? 0)
  let longEdgePx: number | null = null
  if (options?.role === 'tool-result' && limits.toolResultRejectsAboveNative) {
    const tier = limits.family === 'anthropic' ? anthropicResolutionTier(model) : 'standard'
    longEdgePx = limits.nativeLongEdgePx[tier]
  }
  const base64Ceiling = limits.maxBase64Bytes ?? limits.maxRequestBytes
  return { limits, sidePx, longEdgePx, patches: limits.maxPatchesPerImage, rawBytes: Math.floor((base64Ceiling / 4) * 3) }
}


export function detectImageFormatFromBuffer(buffer: Buffer): DetectedFormat {
  if (buffer.length < 4) return 'image/png'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp'
  }
  return 'image/png'
}

export function detectImageFormatFromBase64(base64: string): DetectedFormat {
  try {
    return detectImageFormatFromBuffer(Buffer.from(base64, 'base64'))
  } catch (error) {
    passedOver(error)
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
  if (caps.patches !== null && patchCountOf(width, height, caps.patches.patchPx) > caps.patches.count) {
    scale = Math.min(scale, Math.sqrt((caps.patches.patchPx * caps.patches.patchPx * caps.patches.count) / (width * height)))
  }
  if (scale >= 1) return null
  const at = (factor: number): { width: number; height: number } => ({ width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) })
  let target = at(scale)
  if (caps.patches !== null) {
    while (patchCountOf(target.width, target.height, caps.patches.patchPx) > caps.patches.count && (target.width > 1 || target.height > 1)) {
      scale *= 0.995
      target = at(scale)
    }
  }
  return target
}

async function readDimensions(sharp: SharpFunction, buffer: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await sharp(buffer).metadata()
    if (metadata.width && metadata.height) return { width: metadata.width, height: metadata.height }
  } catch (error) {
    passedOver(error)
  }
  const header = imageDimensionsFromHeader(buffer)
  return header === null ? null : { width: header.width, height: header.height }
}

function limitWords(caps: Caps, role: ImageRole): string {
  const parts: string[] = []
  if (caps.sidePx !== null) parts.push(`${caps.sidePx} px per side`)
  if (caps.longEdgePx !== null) parts.push(`${caps.longEdgePx} px on the long edge for a ${role === 'tool-result' ? 'tool result' : 'model input'}`)
  if (caps.patches !== null) parts.push(`${caps.patches.count.toLocaleString('en-US')} patches of ${caps.patches.patchPx} px per image`)
  parts.push(
    caps.limits.maxBase64Bytes === null
      ? `${formatFileSize(caps.limits.maxRequestBytes)} per request as base64`
      : `${formatFileSize(caps.limits.maxBase64Bytes)} per image as base64`,
  )
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
  const role: ImageRole = options?.role ?? 'input'
  const caps = await resolveCaps(options)
  const detectedHeader = imageDimensionsFromHeader(imageBuffer)
  const rawSubtype = detectedHeader !== null ? detectedHeader.format : (ext.replace(/^\./, '').toLowerCase() || subtypeOf(imageBuffer))
  const sourceSubtype = normalizeSubtype(rawSubtype)
  const sharp = await getImageProcessor()
  const dims = await readDimensions(sharp, imageBuffer)
  if (dims === null) {
    if (originalSize <= caps.rawBytes) {
      return { buffer: imageBuffer, mediaType: sourceSubtype }
    }
    throw new ImageResizeError(
      `Image (${formatFileSize(originalSize)}, ${formatFileSize(base64LengthOf(originalSize))} as base64) exceeds ${limitWords(caps, role)} and could not be decoded to shrink it.`,
    )
  }
  const fitted = fitDimensions(dims.width, dims.height, caps)
  if (fitted === null && imageBuffer.length <= caps.rawBytes) {
    return {
      buffer: imageBuffer,
      mediaType: sourceSubtype,
      dimensions: {
        originalWidth: dims.width,
        originalHeight: dims.height,
        displayWidth: dims.width,
        displayHeight: dims.height,
      },
    }
  }
  const state = await imageProcessorState()
  const isNative = state.road === 'native'
  const baseWidth = fitted !== null ? fitted.width : dims.width
  const baseHeight = fitted !== null ? fitted.height : dims.height
  const candidates: Array<{ target: { width: number; height: number } | null; encoding: Encoding }> = []
  if (fitted !== null) {
    candidates.push({ target: fitted, encoding: { kind: 'source' } })
  }
  if (isNative) {
    candidates.push({ target: fitted, encoding: { kind: 'png', palette: true } })
    candidates.push({ target: fitted, encoding: { kind: 'jpeg', quality: 80 } })
    candidates.push({ target: fitted, encoding: { kind: 'jpeg', quality: 60 } })
    candidates.push({ target: fitted, encoding: { kind: 'jpeg', quality: 40 } })
  } else if (fitted === null) {
    candidates.push({ target: null, encoding: { kind: 'png', palette: false } })
  }
  for (const scale of [0.75, 0.5, 0.35, 0.25, 0.15]) {
    const target = {
      width: Math.max(1, Math.floor(baseWidth * scale)),
      height: Math.max(1, Math.floor(baseHeight * scale)),
    }
    candidates.push({ target, encoding: { kind: 'png', palette: isNative } })
    if (isNative) {
      candidates.push({ target, encoding: { kind: 'jpeg', quality: 60 } })
    }
  }
  const lastTarget = {
    width: Math.max(1, Math.floor(baseWidth * 0.1)),
    height: Math.max(1, Math.floor(baseHeight * 0.1)),
  }
  candidates.push({
    target: lastTarget,
    encoding: isNative ? { kind: 'jpeg', quality: 30 } : { kind: 'png', palette: false },
  })
  let firstError: unknown = null
  let lastProduced: Buffer | null = null
  for (const candidate of candidates) {
    try {
      const produced = await attempt(sharp, imageBuffer, sourceSubtype, candidate.target, candidate.encoding)
      lastProduced = produced
      if (produced.length <= caps.rawBytes) {
        const outHeader = imageDimensionsFromHeader(produced)
        const displayWidth = outHeader?.width ?? candidate.target?.width ?? dims.width
        const displayHeight = outHeader?.height ?? candidate.target?.height ?? dims.height
        return {
          buffer: produced,
          mediaType: subtypeOf(produced),
          dimensions: {
            originalWidth: dims.width,
            originalHeight: dims.height,
            displayWidth,
            displayHeight,
          },
        }
      }
    } catch (error) {
      if (firstError === null) firstError = error
      passedOver(error)
    }
  }
  if (lastProduced === null) {
    const reason = firstError instanceof Error ? firstError.message : String(firstError)
    throw new ImageResizeError(
      `Image (${dims.width}x${dims.height} px, ${formatFileSize(imageBuffer.length)}, ${formatFileSize(base64LengthOf(imageBuffer.length))} as base64) exceeds ${limitWords(caps, role)} and could not be re-encoded: ${reason}`,
    )
  }
  throw new ImageResizeError(
    `Image (${dims.width}x${dims.height} px, ${formatFileSize(imageBuffer.length)}, ${formatFileSize(base64LengthOf(imageBuffer.length))} as base64) could not fit within ${limitWords(caps, role)}; even the smallest encoding (${formatFileSize(lastProduced.length)} ${subtypeOf(lastProduced)}, ${formatFileSize(base64LengthOf(lastProduced.length))} as base64) exceeds the limit.`,
  )
}


export async function maybeResizeAndDownsampleImageBlock(
  imageBlock: ImageBlockParam,
  options?: ResizeOptions,
): Promise<ImageBlockWithDimensions> {
  if (imageBlock.source.type !== 'base64') {
    return { block: imageBlock }
  }
  const buffer = Buffer.from(imageBlock.source.data, 'base64')
  const ext = imageBlock.source.media_type?.split('/')[1] || 'png'
  const resized = await maybeResizeAndDownsampleImageBuffer(buffer, buffer.length, ext, options)
  return {
    block: {
      ...imageBlock,
      source: {
        type: 'base64',
        media_type: `image/${resized.mediaType}` as Base64ImageSource['media_type'],
        data: resized.buffer.toString('base64'),
      },
    },
    dimensions: resized.dimensions,
  }
}

export async function clampToolResultImageBlocks(
  block: ToolResultBlockParam,
  options?: Omit<ResizeOptions, 'role'>,
): Promise<void> {
  if (!Array.isArray(block.content)) return
  const parts = block.content
  const count = parts.filter(part => part.type === 'image').length
  const notes: string[] = []
  let ordinal = 0
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part === undefined || part.type !== 'image') continue
    ordinal++
    if (part.source.type !== 'base64') continue
    try {
      const resized = await maybeResizeAndDownsampleImageBlock(part, { ...options, role: 'tool-result' })
      parts[index] = resized.block
      const note = resized.dimensions === undefined ? null : createImageMetadataText(resized.dimensions, undefined, { index: ordinal, count })
      if (note !== null) notes.push(note)
    } catch (error) {
      passedOver(error)
    }
  }
  for (const text of notes) parts.push({ type: 'text', text })
}

export interface RequestImageFit<M> {
  messages: M[]
  firstEdited: number
  images: number
  sized: number
  leftOut: number
  sidePx: number | null
}

export interface RequestImageFitOptions {
  limits?: ImageLimits
  model?: string
  owner?: string
  statedSidePx?: number | null
}

export interface ImagesLeftOutReceiptV1 {
  count: number
  images: number
  sidePx: number
  at: number
}

type RequestRow = { type: string }
type BlockRecord = Record<string, unknown> & { type?: unknown }

const HEADER_PREFIX_CHARS = 96 * 1024
const SIZED_IMAGE_CACHE_BYTES = 64 * 1024 * 1024
const LEFT_OUT_MEMO_CAP = 2048
const sizedImageCache = new Map<string, Base64ImageSource>()
let sizedImageCacheBytes = 0
const leftOutImages = new Set<string>()
const leftOutReceipts = new Map<string, ImagesLeftOutReceiptV1>()
const fittedImagesByOwner = new Map<string, Map<number, Array<{ hash: string; sidePx: number }>>>()

export function resetFittedImagesForTesting(): void {
  fittedImagesByOwner.clear()
}

function imageHash(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

function rememberedFitSidePx(owner: string | undefined, data: string): number | undefined {
  if (owner === undefined) return undefined
  const sameLength = fittedImagesByOwner.get(owner)?.get(data.length)
  if (sameLength === undefined) return undefined
  const hash = imageHash(data)
  return sameLength.find(entry => entry.hash === hash)?.sidePx
}

function rememberFit(owner: string | undefined, data: string, hash: string, sidePx: number): void {
  if (owner === undefined) return
  let byLength = fittedImagesByOwner.get(owner)
  if (byLength === undefined) {
    byLength = new Map()
    fittedImagesByOwner.set(owner, byLength)
  }
  let entries = byLength.get(data.length)
  if (entries === undefined) {
    entries = []
    byLength.set(data.length, entries)
  }
  const held = entries.find(entry => entry.hash === hash)
  if (held === undefined) entries.push({ hash, sidePx })
  else if (sidePx < held.sidePx) held.sidePx = sidePx
}

function effectiveSidePx(owner: string | undefined, data: string, sidePx: number | null): number | null {
  const remembered = rememberedFitSidePx(owner, data)
  if (remembered === undefined) return sidePx
  return sidePx === null ? remembered : Math.min(sidePx, remembered)
}

export function imageLeftOutNote(dims: { width: number; height: number }, mediaType: string | undefined, sidePx: number): string {
  return `[An image of ${dims.width}x${dims.height} px${mediaType ? ` (${mediaType})` : ''} could not be sized to this request's ${sidePx} px limit and was left out of the request; the transcript keeps it.]`
}

export function imageUnreadableNote(mediaType: string | undefined, sidePx: number, imagesInRequest: number): string {
  return `[An image${mediaType ? ` (${mediaType})` : ''} whose size could not be read was left out of this request of ${imagesInRequest} images, which the API holds to ${sidePx} px a side; the transcript keeps it.]`
}

export function overManyImagesThreshold(limits: ImageLimits, imagesInRequest: number): boolean {
  return limits.manyImages !== null && imagesInRequest > limits.manyImages.threshold
}

export function imagesLeftOutNoticeLine(receipt: { count: number; images: number; sidePx: number }): string {
  const one = receipt.count === 1
  const what = one ? 'one image' : `${receipt.count} images`
  const of = receipt.images > receipt.count ? ` of the ${receipt.images} in this request` : ''
  return `${what}${of} could not be sized to the API's ${receipt.sidePx} px limit and ${one ? 'was' : 'were'} left out of what the model sees — the transcript keeps the original${one ? '' : 's'}; /health's Image processor row names the road this Mercury is on`
}

export function takeImagesLeftOutReceipt(owner: string): ImagesLeftOutReceiptV1 | null {
  const receipt = leftOutReceipts.get(owner) ?? null
  leftOutReceipts.delete(owner)
  return receipt
}

export function imagesLeftOutMarked(messages: readonly unknown[]): boolean {
  return messages.some(message => {
    const row = message as { type?: unknown; attachment?: { type?: unknown } } | null
    return row?.type === 'attachment' && row.attachment?.type === 'images_left_out'
  })
}

export function resetImagesLeftOutForTesting(): void {
  leftOutImages.clear()
  leftOutReceipts.clear()
}

export function imageDimensionsOfBase64(data: string): { width: number; height: number } | null {
  const head = imageDimensionsFromHeader(Buffer.from(data.length > HEADER_PREFIX_CHARS ? data.slice(0, HEADER_PREFIX_CHARS) : data, 'base64'))
  if (head !== null || data.length <= HEADER_PREFIX_CHARS) return head
  return imageDimensionsFromHeader(Buffer.from(data, 'base64'))
}

function isBase64ImageRecord(block: unknown): block is ImageBlockParam & { source: Base64ImageSource } {
  if (typeof block !== 'object' || block === null) return false
  const candidate = block as BlockRecord & { source?: { type?: unknown; data?: unknown } }
  return candidate.type === 'image' && typeof candidate.source === 'object' && candidate.source !== null && candidate.source.type === 'base64' && typeof candidate.source.data === 'string'
}

function contentOfRow(row: unknown): unknown[] | null {
  const content = (row as { message?: { content?: unknown } } | null)?.message?.content
  return Array.isArray(content) ? content : null
}

export function countRequestImages(messages: readonly unknown[]): number {
  let count = 0
  for (const row of messages) {
    if ((row as RequestRow).type !== 'user') continue
    const content = contentOfRow(row)
    if (content === null) continue
    for (const block of content) {
      if (isBase64ImageRecord(block)) count++
      const nested = (block as BlockRecord).type === 'tool_result' ? (block as BlockRecord).content : undefined
      if (Array.isArray(nested)) for (const inner of nested) if (isBase64ImageRecord(inner)) count++
    }
  }
  return count
}

function sizedImageKey(data: string, sidePx: number, limits: ImageLimits, hash: string = imageHash(data)): string {
  const ceiling = limits.maxBase64Bytes ?? limits.maxRequestBytes
  const patches = limits.maxPatchesPerImage === null ? 'none' : `${limits.maxPatchesPerImage.patchPx}x${limits.maxPatchesPerImage.count}`
  return `${sidePx}:${ceiling}:${patches}:${data.length}:${hash}`
}

function rememberSized(key: string, source: Base64ImageSource): void {
  if (source.data.length > SIZED_IMAGE_CACHE_BYTES) return
  while (sizedImageCacheBytes + source.data.length > SIZED_IMAGE_CACHE_BYTES && sizedImageCache.size > 0) {
    const oldest = sizedImageCache.keys().next().value
    if (oldest === undefined) break
    sizedImageCacheBytes -= sizedImageCache.get(oldest)?.data.length ?? 0
    sizedImageCache.delete(oldest)
  }
  sizedImageCache.set(key, source)
  sizedImageCacheBytes += source.data.length
}

type SizedImage =
  | { kind: 'as-is' }
  | { kind: 'sized'; source: Base64ImageSource; key: string; hash: string }
  | { kind: 'left-out'; note: string; key: string; hash: string }

function rememberLeftOut(key: string): void {
  if (leftOutImages.size >= LEFT_OUT_MEMO_CAP) leftOutImages.clear()
  leftOutImages.add(key)
}

async function sizedImageSource(
  block: ImageBlockParam & { source: Base64ImageSource },
  sidePx: number,
  limits: ImageLimits,
  model: string | undefined,
  imagesInRequest: number,
): Promise<SizedImage> {
  const dims = imageDimensionsOfBase64(block.source.data)
  if (dims === null) {
    if (!overManyImagesThreshold(limits, imagesInRequest)) return { kind: 'as-is' }
    logForDebugging(`an image whose size could not be read is left out of a request of ${imagesInRequest} images (the ${sidePx} px cap applies and nothing says it fits; a one-line note takes its place; the transcript keeps it)`, { level: 'warn' })
    const hash = imageHash(block.source.data)
    return { kind: 'left-out', note: imageUnreadableNote(block.source.media_type, sidePx, imagesInRequest), key: `unreadable:${sizedImageKey(block.source.data, sidePx, limits, hash)}`, hash }
  }
  if (Math.max(dims.width, dims.height) <= sidePx) return { kind: 'as-is' }
  const hash = imageHash(block.source.data)
  const key = sizedImageKey(block.source.data, sidePx, limits, hash)
  const remembered = sizedImageCache.get(key)
  if (remembered !== undefined) return { kind: 'sized', source: remembered, key, hash }
  const note = imageLeftOutNote(dims, block.source.media_type, sidePx)
  if (leftOutImages.has(key)) return { kind: 'left-out', note, key, hash }
  try {
    const resized = await maybeResizeAndDownsampleImageBlock(block, { limits: { ...limits, maxSidePx: sidePx }, model, imagesInRequest, role: 'input' })
    if (resized.block.source.type !== 'base64') return { kind: 'as-is' }
    rememberSized(key, resized.block.source)
    return { kind: 'sized', source: resized.block.source, key, hash }
  } catch (error) {
    logForDebugging(`an image of ${dims.width}x${dims.height} px could not be sized to the request's ${sidePx} px cap and is left out of the request (a one-line note takes its place; the transcript keeps it): ${error instanceof Error ? error.message : String(error)}`, { level: 'warn' })
    rememberLeftOut(key)
    return { kind: 'left-out', note, key, hash }
  }
}

export async function fitImagesToRequestCap<M extends RequestRow>(
  messages: M[],
  options?: RequestImageFitOptions,
): Promise<RequestImageFit<M>> {
  const limits = options?.limits ?? imageLimitsForModel(options?.model ?? (await engineModel()))
  const images = countRequestImages(messages)
  const sidePx = requestImageSidePx(limits, images, options?.statedSidePx)
  const owner = options?.owner
  const conversation = owner === undefined ? undefined : conversationEditKey(owner, messages as Array<{ type: string; uuid?: unknown }>)
  const identity: RequestImageFit<M> = { messages, firstEdited: -1, images, sized: 0, leftOut: 0, sidePx }
  if (images === 0 || (sidePx === null && (conversation === undefined || (fittedImagesByOwner.get(conversation)?.size ?? 0) === 0))) return identity
  let leftOut = 0
  let leftOutCap: number | null = sidePx
  const edits: WireEdit[] = []
  const fitBlock = async (block: unknown, index: number): Promise<unknown> => {
    if (!isBase64ImageRecord(block)) return block
    const capPx = effectiveSidePx(conversation, block.source.data, sidePx)
    if (capPx === null) return block
    const fitted = await sizedImageSource(block, capPx, limits, options?.model, images)
    if (fitted.kind === 'as-is') return block
    rememberFit(conversation, block.source.data, fitted.hash, capPx)
    edits.push({ index, key: `${fitted.kind}:${fitted.key}` })
    if (fitted.kind === 'sized') return { ...block, source: fitted.source }
    leftOut++
    leftOutCap = capPx
    return { type: 'text', text: fitted.note }
  }
  let firstEdited = -1
  let sized = 0
  const out: M[] = []
  for (let index = 0; index < messages.length; index++) {
    const row = messages[index]!
    const content = row.type === 'user' ? contentOfRow(row) : null
    if (content === null) {
      out.push(row)
      continue
    }
    let changed = false
    const blocks: unknown[] = []
    for (const block of content) {
      const fitted = await fitBlock(block, index)
      if (fitted !== block) {
        changed = true
        sized++
        blocks.push(fitted)
        continue
      }
      const nested = (block as BlockRecord).type === 'tool_result' ? (block as BlockRecord).content : undefined
      if (!Array.isArray(nested)) {
        blocks.push(block)
        continue
      }
      let innerChanged = false
      const inner: unknown[] = []
      for (const part of nested) {
        const fitted = await fitBlock(part, index)
        if (fitted !== part) {
          innerChanged = true
          sized++
        }
        inner.push(fitted)
      }
      if (!innerChanged) {
        blocks.push(block)
        continue
      }
      changed = true
      blocks.push({ ...(block as BlockRecord), content: inner })
    }
    if (!changed) {
      out.push(row)
      continue
    }
    if (firstEdited === -1) firstEdited = index
    const carrier = row as M & { message: Record<string, unknown> }
    out.push({ ...carrier, message: { ...carrier.message, content: blocks } })
  }
  if (firstEdited === -1) return identity
  sized -= leftOut
  logForDebugging(`${sized} of the ${images} images in this request sized to ${sidePx ?? 'their remembered'} px a side${leftOut > 0 ? `, ${leftOut} left out of the request` : ''} (${limits.family} limits${limits.manyImages !== null && (limits.manyImages.fromFirstSend || images > limits.manyImages.threshold) ? `, the bound for a request with more than ${limits.manyImages.threshold} images${limits.manyImages.fromFirstSend ? ' applied from an image\'s first send' : ''}${options?.statedSidePx !== null && options?.statedSidePx !== undefined ? `, held to the ${options.statedSidePx} px a refusal in this conversation stated` : ''}` : ''})`)
  if (leftOut > 0 && owner !== undefined && leftOutCap !== null) leftOutReceipts.set(owner, { count: leftOut, images, sidePx: leftOutCap, at: Date.now() })
  const settled = settleWireEdits(owner, out, edits)
  return { messages: settled.messages, firstEdited: settled.firstEdited, images, sized, leftOut, sidePx }
}


async function compressImageBuffer(
  imageBuffer: Buffer,
  maxBytes: number,
  originalMediaType?: string,
): Promise<{ base64: string; mediaType: DetectedFormat; originalSize: number }> {
  const originalSize = imageBuffer.length
  if (originalSize <= maxBytes) {
    return {
      base64: imageBuffer.toString('base64'),
      mediaType: detectImageFormatFromBuffer(imageBuffer),
      originalSize,
    }
  }
  const sharp = await getImageProcessor()
  const dims = await readDimensions(sharp, imageBuffer)
  const width = dims?.width ?? 2000
  const height = dims?.height ?? 2000
  const detectedMime = originalMediaType
    ? originalMediaType.includes('/')
      ? originalMediaType.toLowerCase()
      : `image/${normalizeSubtype(originalMediaType.toLowerCase())}`
    : detectImageFormatFromBuffer(imageBuffer)
  const scaleEncoding: Encoding =
    detectedMime === 'image/png'
      ? { kind: 'png', palette: true }
      : detectedMime === 'image/webp'
        ? { kind: 'webp', quality: 80 }
        : { kind: 'jpeg', quality: 80 }
  const sourceSub = subtypeOf(imageBuffer)
  const steps: Array<{ target: { width: number; height: number }; encoding: Encoding }> = [
    ...[1, 0.75, 0.5, 0.25].map(scale => ({
      target: {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
      },
      encoding: scaleEncoding,
    })),
    { target: { width: 800, height: 800 }, encoding: { kind: 'png', palette: true } },
    { target: { width: 600, height: 600 }, encoding: { kind: 'jpeg', quality: 50 } },
    { target: { width: 400, height: 400 }, encoding: { kind: 'jpeg', quality: 20 } },
  ]
  for (const step of steps) {
    try {
      const produced = await attempt(sharp, imageBuffer, sourceSub, step.target, step.encoding)
      if (produced.length <= maxBytes) {
        return {
          base64: produced.toString('base64'),
          mediaType: detectImageFormatFromBuffer(produced),
          originalSize,
        }
      }
    } catch (error) {
      passedOver(error)
    }
  }
  throw new ImageResizeError(
    `Image (${formatFileSize(originalSize)}) could not be compressed to fit the Read tool budget of ${formatFileSize(maxBytes)} (this is the Read tool's own budget, separate from provider image limits); supply a smaller image or a larger budget.`,
  )
}

export async function compressImageBufferWithTokenLimit(
  imageBuffer: Buffer,
  maxTokens: number,
  originalMediaType?: string,
): Promise<{ base64: string; mediaType: DetectedFormat; originalSize: number }> {
  const maxBase64Chars = Math.floor(maxTokens / 0.125)
  const maxBytes = Math.floor((maxBase64Chars * 3) / 4)
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
      media_type: result.mediaType,
      data: result.base64,
    },
  }
}


export function createImageMetadataText(
  dims: ImageDimensions,
  sourcePath?: string,
  ordinal?: { index: number; count: number },
): string | null {
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
    const x = (originalWidth / displayWidth).toFixed(2)
    const y = (originalHeight / displayHeight).toFixed(2)
    parts.push(`original dimensions: ${originalWidth}x${originalHeight}`)
    parts.push(`displayed at: ${displayWidth}x${displayHeight}`)
    parts.push(x === y
      ? `multiply any coordinates you read off this image by ${x} to map them onto the original`
      : `multiply x coordinates by ${x} and y coordinates by ${y} to map them onto the original`)
  }
  const head = ordinal === undefined ? 'Image' : `Image ${ordinal.index} of ${ordinal.count}`
  return `[${head}: ${parts.join(', ')}]`
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
