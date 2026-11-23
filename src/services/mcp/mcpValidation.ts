import { flagEnv } from '../../substrate/flagRegistry.js'
import { countMessagesTokensWithAPI, roughTokenCountEstimation } from '../tokenEstimation.js'
import type { ContentBlockParam, ImageBlockParam, MessageParam, TextBlockParam } from '../../types/wire.js'
import { compressImageBlock } from '../../utils/imageResizer.js'
import { logError } from '../../utils/log.js'
import { passedOver } from '../../utils/passedOver.js'


const MCP_TOKEN_COUNT_THRESHOLD_FACTOR = 0.5
const IMAGE_TOKEN_ESTIMATE = 1600

const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25_000

export type MCPToolResult = string | ContentBlockParam[] | undefined

const CHARS_PER_TOKEN = 4
const IMAGE_CHAR_CHARGE = IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN

function truncationNotice(maxTokens: number): string {
  return (
    `\n\n[Output truncated: the tool result exceeded the ${maxTokens}-token MCP output limit. ` +
    'If this MCP server offers pagination or filtering tools, use them to fetch the specific portions you need. ' +
    'If pagination is unavailable, tell the user that you are working with truncated output and that the results may be incomplete.]'
  )
}

export function getMaxMcpOutputTokens(): number {
  const raw = flagEnv('MERCURY_MCP_OUTPUT_TOKENS')
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_MAX_MCP_OUTPUT_TOKENS
}

export function getContentSizeEstimate(content: MCPToolResult): number {
  if (content === undefined) return 0
  if (typeof content === 'string') {
    return roughTokenCountEstimation(content)
  }
  let total = 0
  for (const block of content) {
    if (block.type === 'text') {
      total += roughTokenCountEstimation(block.text)
    } else if (block.type === 'image') {
      total += IMAGE_TOKEN_ESTIMATE
    }
  }
  return total
}

export async function mcpContentNeedsTruncation(content: MCPToolResult): Promise<boolean> {
  if (content === undefined) return false
  const maxTokens = getMaxMcpOutputTokens()
  const estimate = getContentSizeEstimate(content)
  if (estimate <= maxTokens * MCP_TOKEN_COUNT_THRESHOLD_FACTOR) {
    return false
  }
  const message: MessageParam = {
    role: 'user',
    content,
  }
  try {
    const count = await countMessagesTokensWithAPI([message], [])
    return count !== null && count > maxTokens
  } catch (error) {
    logError(error)
    return estimate > maxTokens
  }
}

export async function truncateMcpContent(content: MCPToolResult): Promise<MCPToolResult> {
  if (content === undefined) return undefined
  const maxTokens = getMaxMcpOutputTokens()
  const maxChars = maxTokens * CHARS_PER_TOKEN
  const notice = truncationNotice(maxTokens)

  if (typeof content === 'string') {
    return content.slice(0, maxChars) + notice
  }

  let remaining = maxChars
  const kept: ContentBlockParam[] = []

  for (const block of content) {
    if (block.type === 'text') {
      if (remaining <= 0) break
      if (block.text.length <= remaining) {
        kept.push(block)
        remaining -= block.text.length
      } else {
        const partial: TextBlockParam = { ...block, text: block.text.slice(0, remaining) }
        kept.push(partial)
        remaining = 0
        break
      }
    } else if (block.type === 'image') {
      const imageBlock: ImageBlockParam = block
      if (remaining >= IMAGE_CHAR_CHARGE) {
        kept.push(imageBlock)
        remaining -= IMAGE_CHAR_CHARGE
      } else if (remaining > 0) {
        const byteAllowance = Math.floor(remaining * 0.75)
        if (byteAllowance <= 0) continue
        try {
          const compressed = await compressImageBlock(imageBlock, byteAllowance)
          kept.push(compressed)
          remaining -=
            compressed.source.type === 'base64'
              ? compressed.source.data.length
              : IMAGE_CHAR_CHARGE
        } catch (error) {
          passedOver(error)
        }
      }
    } else {
      kept.push(block)
    }
  }

  const noticeBlock: TextBlockParam = { type: 'text', text: notice }
  kept.push(noticeBlock)
  return kept
}
