import isEqual from 'lodash-es/isEqual.js'
import type { ContentBlockParam } from '../../../types/wire.js'
import { flagEnabled } from '../../../substrate/flagRegistry.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../../utils/errors.js'
import { createImageMetadataText, type ImageDimensions, ImageResizeError, maybeResizeAndDownsampleImageBuffer } from '../../../utils/imageResizer.js'
import { logMCPError } from '../../../utils/log.js'
import { getBinaryBlobSavedMessage, getFormatDescription, getLargeOutputInstructions, persistBinaryContent } from '../mcpOutputStorage.js'
import { mcpContentNeedsTruncation, truncateMcpContent, type MCPToolResult } from '../mcpValidation.js'
import { persistToolResult } from '../../../utils/toolResultStorage.js'
import { normalizeNameForMCP } from '../../../utils/mcp/normalization.js'
import { passedOver } from '../../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export type MCPResultType = Unbuilt

export type TransformedMCPResult = Unbuilt

function persistId(serverName: string, extra?: string): string {
  return notBuilt('src/services/mcp/client/results.ts:24')
}

export async function transformResultContent(content: unknown[], serverName: string): Promise<ContentBlockParam[]> {
  return notBuilt('src/services/mcp/client/results.ts:66')
}

export function inferCompactSchema(value: unknown, depth?: number): string {
  return notBuilt('src/services/mcp/client/results.ts:126')
}

export async function transformMCPResult(result: unknown, tool: string, name: string): Promise<TransformedMCPResult> {
  return notBuilt('src/services/mcp/client/results.ts:138')
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
