import isEqual from 'lodash-es/isEqual.js'
import type { ContentBlockParam } from '../../../engine/message-shapes/wire.js'
import { flagEnabled } from '../../../platform/substrate/flagRegistry.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../../platform/errors/errors.js'
import { imageDimensionsFromHeader } from '../../../platform/images/imageProcessorJs.js'
import { createImageMetadataText, type ImageDimensions, ImageResizeError, maybeResizeAndDownsampleImageBuffer } from '../../../platform/images/imageResizer.js'
import { logMCPError } from '../../../platform/logs/errorLog.js'
import { getBinaryBlobSavedMessage, getFormatDescription, getLargeOutputInstructions, persistBinaryContent } from '../mcpOutputStorage.js'
import { mcpContentNeedsTruncation, truncateMcpContent, type MCPToolResult } from '../mcpOutputTruncation.js'
import { persistToolResult } from '../../../engine/tool-dispatch/toolResultStorage.js'
import { normalizeNameForMCP } from '../../mcp-shapes/normalization.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

type ForwardableMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export type MCPResultType = 'toolResult' | 'structuredContent' | 'contentArray'

type TransformedMCPResult = {
  content: MCPToolResult
  type: MCPResultType
  schema?: string
  isImage?: boolean
}

function persistId(serverName: string, extra?: string): string {
  const parts = [normalizeNameForMCP(serverName)]
  const normalizedExtra = extra ? normalizeNameForMCP(extra) : ''
  if (normalizedExtra) parts.push(normalizedExtra)
  parts.push(String(Date.now()), Math.random().toString(36).slice(2, 8))
  return parts.join('-')
}

function forwardableImage(bytes: Buffer): ForwardableMediaType | null {
  const header = imageDimensionsFromHeader(bytes)
  if (header === null || header.width <= 0 || header.height <= 0) return null
  const mime = `image/${header.format}`
  if (!IMAGE_MIME_TYPES.has(mime)) return null
  return mime as ForwardableMediaType
}

async function resizedImageBlock(
  bytes: Buffer,
  detectedMime: ForwardableMediaType,
): Promise<{ block: ContentBlockParam; dimensions?: ImageDimensions }> {
  const ext = detectedMime.slice('image/'.length)
  try {
    const resized = await maybeResizeAndDownsampleImageBuffer(bytes, bytes.length, ext, { role: 'tool-result' })
    const rawType = resized.mediaType.startsWith('image/') ? resized.mediaType : `image/${resized.mediaType}`
    const normalized = rawType === 'image/jpg' ? 'image/jpeg' : rawType
    const mediaType: ForwardableMediaType = IMAGE_MIME_TYPES.has(normalized)
      ? (normalized as ForwardableMediaType)
      : detectedMime
    return {
      block: {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: resized.buffer.toString('base64'),
        },
      },
      dimensions: resized.dimensions,
    }
  } catch (error) {
    if (error instanceof ImageResizeError) throw error
    passedOver(error)
    return {
      block: {
        type: 'image',
        source: {
          type: 'base64',
          media_type: detectedMime,
          data: bytes.toString('base64'),
        },
      },
    }
  }
}

async function persistBlob(
  bytes: Buffer,
  mimeType: string | undefined,
  serverName: string,
  sourceDescription: string,
  extra?: string,
): Promise<string> {
  const persisted = await persistBinaryContent(bytes, mimeType, persistId(serverName, extra))
  const failure = (persisted as { error?: string }).error
  if (failure !== undefined) {
    return `${sourceDescription}: binary content could not be saved (${mimeType || 'unknown type'}, ${bytes.length} bytes): ${failure}`
  }
  const saved = persisted as { filepath: string; size: number }
  return getBinaryBlobSavedMessage(saved.filepath, mimeType, saved.size, sourceDescription)
}

export async function transformResultContent(content: unknown[], serverName: string): Promise<ContentBlockParam[]> {
  const blocks: ContentBlockParam[] = []
  const forwardedImageDims: Array<ImageDimensions | undefined> = []

  const pushImage = async (
    bytes: Buffer,
    mimeType: string | undefined,
    sourceDescription: string,
    extra: string,
  ): Promise<void> => {
    const detected = forwardableImage(bytes)
    if (detected !== null) {
      const { block, dimensions } = await resizedImageBlock(bytes, detected)
      blocks.push(block)
      forwardedImageDims.push(dimensions)
      return
    }
    const savedText = await persistBlob(bytes, mimeType, serverName, sourceDescription, extra)
    blocks.push({ type: 'text', text: savedText })
  }

  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const kind = rec.type

    if (kind === 'text') {
      const text =
        typeof rec.text === 'string'
          ? rec.text
          : rec.text === undefined || rec.text === null
            ? ''
            : String(rec.text)
      blocks.push({ type: 'text', text })
      continue
    }

    if (kind === 'image') {
      const data = typeof rec.data === 'string' ? rec.data : ''
      const mimeType = typeof rec.mimeType === 'string' ? rec.mimeType : undefined
      await pushImage(Buffer.from(data, 'base64'), mimeType, `Image from ${serverName}`, 'image')
      continue
    }

    if (kind === 'audio') {
      const data = typeof rec.data === 'string' ? rec.data : ''
      const mimeType = typeof rec.mimeType === 'string' ? rec.mimeType : undefined
      const savedText = await persistBlob(
        Buffer.from(data, 'base64'),
        mimeType,
        serverName,
        `Audio from ${serverName}`,
        'audio',
      )
      blocks.push({ type: 'text', text: savedText })
      continue
    }

    if (kind === 'resource') {
      const resource = rec.resource
      if (!resource || typeof resource !== 'object') continue
      const res = resource as Record<string, unknown>
      const uri = typeof res.uri === 'string' && res.uri.length > 0 ? res.uri : 'unknown'
      const marker = `Resource from ${serverName} at ${uri}`
      if (typeof res.text === 'string') {
        blocks.push({ type: 'text', text: `${marker}:\n${res.text}` })
        continue
      }
      if (typeof res.blob === 'string') {
        const bytes = Buffer.from(res.blob, 'base64')
        const mimeType = typeof res.mimeType === 'string' ? res.mimeType : undefined
        if (mimeType?.startsWith('image/')) {
          const detected = forwardableImage(bytes)
          if (detected !== null) {
            blocks.push({ type: 'text', text: marker })
            const { block, dimensions } = await resizedImageBlock(bytes, detected)
            blocks.push(block)
            forwardedImageDims.push(dimensions)
            continue
          }
        }
        const savedText = await persistBlob(bytes, mimeType, serverName, marker, 'resource')
        blocks.push({ type: 'text', text: savedText })
      }
      continue
    }

    if (kind === 'resource_link') {
      const name = typeof rec.name === 'string' ? rec.name : ''
      const uri = typeof rec.uri === 'string' ? rec.uri : ''
      const description =
        typeof rec.description === 'string' && rec.description.length > 0 ? ` (${rec.description})` : ''
      blocks.push({ type: 'text', text: `Resource: ${name} (${uri})${description}` })
    }
  }

  const totalImages = forwardedImageDims.length
  for (let index = 0; index < totalImages; index++) {
    const dims = forwardedImageDims[index]
    if (!dims) continue
    const note = createImageMetadataText(dims, undefined, { index: index + 1, count: totalImages })
    if (note !== null) blocks.push({ type: 'text', text: note })
  }

  return blocks
}

function inferCompactSchema(value: unknown, depth: number = 2): string {
  if (value === null) return 'null'
  if (typeof value !== 'object') return typeof value
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${inferCompactSchema(value[0], depth)}]`
  }
  if (depth <= 0) return '{...}'
  const entries = Object.entries(value)
  const shown = entries.slice(0, 10).map(([key, member]) => `${key}: ${inferCompactSchema(member, depth - 1)}`)
  if (entries.length > 10) shown.push('...')
  return `{${shown.join(', ')}}`
}

function restatesStructured(item: unknown, structured: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const rec = item as { type?: unknown; text?: unknown }
  if (rec.type !== 'text' || typeof rec.text !== 'string') return false
  try {
    return isEqual(JSON.parse(rec.text), structured)
  } catch (error) {
    passedOver(error)
    return false
  }
}

export async function transformMCPResult(result: unknown, tool: string, name: string): Promise<TransformedMCPResult> {
  const res =
    result && typeof result === 'object'
      ? (result as { toolResult?: unknown; structuredContent?: unknown; content?: unknown })
      : null

  if (res !== null && res.toolResult !== undefined) {
    const content =
      typeof res.toolResult === 'string'
        ? res.toolResult
        : typeof res.toolResult === 'object' && res.toolResult !== null
          ? JSON.stringify(res.toolResult)
          : String(res.toolResult)
    return { content, type: 'toolResult' }
  }

  if (res !== null && res.structuredContent !== undefined) {
    const serialized = JSON.stringify(res.structuredContent)
    const schema = inferCompactSchema(res.structuredContent)
    const remaining = Array.isArray(res.content)
      ? res.content.filter(item => !restatesStructured(item, res.structuredContent))
      : []
    if (remaining.length === 0) {
      return { content: serialized, type: 'structuredContent', schema }
    }
    const converted = await transformResultContent(remaining, name)
    const isImage = converted.some(block => block.type === 'image')
    return {
      content: [...converted, { type: 'text', text: serialized }],
      type: 'structuredContent',
      schema,
      isImage,
    }
  }

  if (res !== null && Array.isArray(res.content)) {
    const converted = await transformResultContent(res.content, name)
    const isImage = converted.some(block => block.type === 'image')
    return {
      content: converted,
      type: 'contentArray',
      schema: inferCompactSchema(res.content),
      isImage,
    }
  }

  logMCPError(name, `unexpected response format from tool ${tool}`)
  throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    `Unexpected response format from MCP server "${name}" tool "${tool}"`,
    'MCP unexpected response format',
  )
}

export async function processMCPResult(result: unknown, tool: string, name: string): Promise<MCPToolResult> {
  const transformed = await transformMCPResult(result, tool, name)
  if (transformed.content === undefined) return transformed.content
  if (!(await mcpContentNeedsTruncation(transformed.content))) return transformed.content
  if (!flagEnabled('MERCURY_MCP_LARGE_OUTPUT_FILES')) return truncateMcpContent(transformed.content)
  if (transformed.isImage) return truncateMcpContent(transformed.content)
  const serialized = typeof transformed.content === 'string' ? transformed.content : JSON.stringify(transformed.content, null, 2)
  const persisted = await persistToolResult(serialized, persistId(name, tool))
  if ('error' in persisted) {
    return `MCP tool result exceeded the maximum allowed tokens (${serialized.length} characters), and saving it to disk failed: ${persisted.error}. If the server offers pagination or filtering tools, use them.`
  }
  return getLargeOutputInstructions(persisted.filepath, serialized.length, getFormatDescription(transformed.type, transformed.schema))
}
