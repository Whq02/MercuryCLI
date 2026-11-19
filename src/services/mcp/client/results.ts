import isEqual from 'lodash-es/isEqual.js'
import type { ContentBlockParam } from '../../../types/wire.js'
import { flagEnabled } from '../../../substrate/flagRegistry.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../../utils/errors.js'
import { createImageMetadataText, type ImageDimensions, ImageResizeError, maybeResizeAndDownsampleImageBuffer } from '../../../utils/imageResizer.js'
import { logMCPError } from '../../../utils/log.js'
import { getBinaryBlobSavedMessage, getFormatDescription, getLargeOutputInstructions, persistBinaryContent } from '../../../utils/mcpOutputStorage.js'
import { mcpContentNeedsTruncation, truncateMcpContent, type MCPToolResult } from '../../../utils/mcpValidation.js'
import { persistToolResult } from '../../../utils/toolResultStorage.js'
import { normalizeNameForMCP } from '../normalization.js'

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export type MCPResultType = 'toolResult' | 'structuredContent' | 'contentArray'

export type TransformedMCPResult = {
  type: MCPResultType
  content: MCPToolResult
  schema?: string
  isImage?: boolean
}

function persistId(serverName: string, extra?: string): string {
  return `${normalizeNameForMCP(serverName)}${extra ? `-${normalizeNameForMCP(extra)}` : ''}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function persistBlob(bytes: Buffer, mimeType: string | undefined, serverName: string, source: string): Promise<ContentBlockParam> {
  const saved = await persistBinaryContent(bytes, mimeType, persistId(serverName))
  if ('error' in saved) {
    return { type: 'text', text: `${source}: binary content could not be saved (${mimeType ?? 'unknown type'}, ${bytes.length} bytes): ${saved.error}` } as ContentBlockParam
  }
  return { type: 'text', text: getBinaryBlobSavedMessage(saved.filepath, mimeType, saved.size, source) } as ContentBlockParam
}

async function resizedImageBlock(base64: string, mimeType: string | undefined): Promise<{ block: ContentBlockParam; dimensions?: ImageDimensions }> {
  const subtype = mimeType?.split('/')[1] ?? 'png'
  const bytes = Buffer.from(base64, 'base64')
  const resized = await maybeResizeAndDownsampleImageBuffer(bytes, bytes.length, subtype, { role: 'tool-result' })
  const block = {
    type: 'image',
    source: { type: 'base64', media_type: `image/${resized.mediaType}`, data: resized.buffer.toString('base64') },
  } as ContentBlockParam
  return { block, dimensions: resized.dimensions }
}

type MCPResource = { uri?: string; text?: string; blob?: string; mimeType?: string } | undefined

function isImageResource(resource: MCPResource): boolean {
  return resource?.text === undefined && resource?.blob !== undefined && resource.mimeType !== undefined && IMAGE_MIME_TYPES.has(resource.mimeType)
}

async function forwardableImage(base64: string, mimeType: string | undefined): Promise<{ block: ContentBlockParam; dimensions: ImageDimensions } | null> {
  let image: { block: ContentBlockParam; dimensions?: ImageDimensions }
  try {
    image = await resizedImageBlock(base64, mimeType)
  } catch (error) {
    if (error instanceof ImageResizeError) return null
    throw error
  }
  const mediaType = (image.block as { source?: { media_type?: string } }).source?.media_type
  if (image.dimensions === undefined || mediaType === undefined || !IMAGE_MIME_TYPES.has(mediaType)) return null
  return { block: image.block, dimensions: image.dimensions }
}

export async function transformResultContent(content: unknown[], serverName: string): Promise<ContentBlockParam[]> {
  const out: ContentBlockParam[] = []
  const shown: Array<{ ordinal: number; dimensions: ImageDimensions }> = []
  let images = 0
  const pushImage = async (base64: string, mimeType: string | undefined): Promise<void> => {
    const image = await forwardableImage(base64, mimeType)
    if (image === null) {
      out.push(await persistBlob(Buffer.from(base64, 'base64'), mimeType, serverName, `Image from ${serverName}`))
      return
    }
    images++
    out.push(image.block)
    shown.push({ ordinal: images, dimensions: image.dimensions })
  }
  for (const block of content) {
    const record = block as Record<string, unknown>
    switch (record.type) {
      case 'text':
        out.push({ type: 'text', text: String(record.text ?? '') } as ContentBlockParam)
        break
      case 'audio': {
        const bytes = Buffer.from(String(record.data ?? ''), 'base64')
        out.push(await persistBlob(bytes, record.mimeType as string | undefined, serverName, `Audio from ${serverName}`))
        break
      }
      case 'image':
        await pushImage(String(record.data ?? ''), record.mimeType as string | undefined)
        break
      case 'resource': {
        const resource = record.resource as MCPResource
        const marker = `Resource from ${serverName} at ${resource?.uri ?? 'unknown'}`
        if (resource?.text !== undefined) {
          out.push({ type: 'text', text: `${marker}:\n${resource.text}` } as ContentBlockParam)
        } else if (resource?.blob !== undefined) {
          if (isImageResource(resource)) {
            out.push({ type: 'text', text: marker } as ContentBlockParam)
            await pushImage(resource.blob, resource.mimeType)
          } else {
            out.push(await persistBlob(Buffer.from(resource.blob, 'base64'), resource.mimeType, serverName, marker))
          }
        }
        break
      }
      case 'resource_link':
        out.push({
          type: 'text',
          text: `Resource: ${String(record.name ?? '')} (${String(record.uri ?? '')})${record.description ? ` (${String(record.description)})` : ''}`,
        } as ContentBlockParam)
        break
      default:
        break
    }
  }
  for (const { ordinal, dimensions } of shown) {
    const note = createImageMetadataText(dimensions, undefined, { index: ordinal, count: images })
    if (note !== null) out.push({ type: 'text', text: note } as ContentBlockParam)
  }
  return out
}

export function inferCompactSchema(value: unknown, depth: number = 2): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${inferCompactSchema(value[0], depth - 1)}]`
  if (typeof value === 'object') {
    if (depth <= 0) return '{...}'
    const entries = Object.entries(value as Record<string, unknown>)
    const shown = entries.slice(0, 10).map(([key, inner]) => `${key}: ${inferCompactSchema(inner, depth - 1)}`)
    return `{${shown.join(', ')}${entries.length > 10 ? ', ...' : ''}}`
  }
  return typeof value
}

export async function transformMCPResult(result: unknown, tool: string, name: string): Promise<TransformedMCPResult> {
  const record = result as { toolResult?: unknown; structuredContent?: unknown; content?: unknown } | null
  if (record && 'toolResult' in record && record.toolResult !== undefined) {
    return { type: 'toolResult', content: String(record.toolResult) }
  }
  if (record && record.structuredContent !== undefined) {
    const serialized = JSON.stringify(record.structuredContent)
    const schema = inferCompactSchema(record.structuredContent)
    const blocks = Array.isArray(record.content) ? record.content : []
    const restates = (block: unknown): boolean => {
      const text = (block as { type?: string; text?: unknown } | null)?.type === 'text' ? (block as { text?: unknown }).text : undefined
      if (typeof text !== 'string') return false
      try {
        return isEqual(JSON.parse(text), record.structuredContent)
      } catch {
        return false
      }
    }
    if (blocks.every(restates)) return { type: 'structuredContent', content: serialized, schema }
    const content = await transformResultContent(blocks.filter(block => !restates(block)), name)
    content.push({ type: 'text', text: serialized } as ContentBlockParam)
    return {
      type: 'structuredContent',
      content,
      schema,
      isImage: content.some(block => (block as { type?: string }).type === 'image'),
    }
  }
  if (record && Array.isArray(record.content)) {
    const content = await transformResultContent(record.content, name)
    return {
      type: 'contentArray',
      content,
      schema: inferCompactSchema(record.content),
      isImage: content.some(block => (block as { type?: string }).type === 'image'),
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
