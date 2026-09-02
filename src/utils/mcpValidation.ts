import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { countMessagesTokensWithAPI, roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { ContentBlockParam, ImageBlockParam, MessageParam, TextBlockParam } from '../types/wire.js'
import { compressImageBlock } from './imageResizer.js'
import { logError } from './log.js'

/**
 * The MCP tool-output token cap: resolution, size estimation, the two-stage
 * truncation decision, and truncation itself.
 */

export const MCP_TOKEN_COUNT_THRESHOLD_FACTOR = 0.5
export const IMAGE_TOKEN_ESTIMATE = 1600

const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25_000

export type MCPToolResult = string | ContentBlockParam[] | undefined

/**
 * Nothing is memoised: the environment and the flag cache are re-read on
 * every call. The flag map's `mcp_tool` entry is a TOKEN count (the map's
 * other entries are consumed elsewhere as character counts — do not convert).
 */
export function getMaxMcpOutputTokens(): number {
  const fromEnv = parseInt(process.env.MAX_MCP_OUTPUT_TOKENS ?? '', 10)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  const flagMap = getFeatureValue_CACHED_MAY_BE_STALE<Record<string, unknown>>('mercury_satin_quoll', {})
  const fromFlag = flagMap?.mcp_tool
  if (typeof fromFlag === 'number' && Number.isFinite(fromFlag) && fromFlag > 0) return fromFlag
  return DEFAULT_MAX_MCP_OUTPUT_TOKENS
}

function maxCharacters(): number {
  return getMaxMcpOutputTokens() * 4
}

export function getContentSizeEstimate(content: MCPToolResult): number {
  if (content === undefined) return 0
  if (typeof content === 'string') return roughTokenCountEstimation(content)
  let total = 0
  for (const block of content) {
    if (block.type === 'text') total += roughTokenCountEstimation((block as TextBlockParam).text)
    else if (block.type === 'image') total += IMAGE_TOKEN_ESTIMATE
  }
  return total
}

/**
 * Two stages: an estimate at or under half the cap declines immediately;
 * otherwise the real counter decides (strictly greater than the cap). A
 * counting failure declines — an outage must not mangle output.
 */
export async function mcpContentNeedsTruncation(content: MCPToolResult): Promise<boolean> {
  if (content === undefined) return false
  const cap = getMaxMcpOutputTokens()
  if (getContentSizeEstimate(content) <= cap * MCP_TOKEN_COUNT_THRESHOLD_FACTOR) return false
  try {
    const message: MessageParam = { role: 'user', content }
    const count = await countMessagesTokensWithAPI([message], [])
    return count !== null && count > cap
  } catch (err) {
    logError(err)
    return false
  }
}

function truncationNotice(): string {
  const cap = getMaxMcpOutputTokens()
  return (
    `\n\n[Output truncated: the tool result exceeded the ${cap}-token MCP output limit. ` +
    `If this MCP server offers pagination or filtering tools, use them to fetch the specific portions you need. ` +
    `If pagination is unavailable, tell the user that you are working with truncated output and that the results may be incomplete.]`
  )
}

/**
 * Text: keep the leading characters up to the budget. Arrays: walk in order
 * — a text block that does not fit keeps exactly the remaining budget and
 * ends the walk; an image that does not fit is compressed into the remaining
 * budget (dropped if that throws); an image reached with no budget left is
 * dropped and the walk CONTINUES; other block kinds pass through uncharged.
 * The notice is always appended.
 */
export async function truncateMcpContent(content: MCPToolResult): Promise<MCPToolResult> {
  if (content === undefined) return content
  const budget = maxCharacters()
  if (typeof content === 'string') return content.slice(0, budget) + truncationNotice()
  const kept: ContentBlockParam[] = []
  let used = 0
  for (const block of content) {
    if (block.type === 'text') {
      const remaining = budget - used
      if (remaining <= 0) break
      const text = (block as TextBlockParam).text
      if (text.length <= remaining) {
        kept.push(block)
        used += text.length
        continue
      }
      kept.push({ ...(block as TextBlockParam), text: text.slice(0, remaining) })
      break
    }
    if (block.type === 'image') {
      const remaining = budget - used
      const flatCharge = IMAGE_TOKEN_ESTIMATE * 4
      if (flatCharge <= remaining) {
        kept.push(block)
        used += flatCharge
        continue
      }
      if (remaining > 0) {
        try {
          const compressed = await compressImageBlock(block as ImageBlockParam, Math.floor(remaining * 0.75))
          kept.push(compressed)
          used += compressed.source.type === 'base64' ? compressed.source.data.length : flatCharge
        } catch {
          // Dropped; the walk continues and nothing is charged.
        }
      }
      continue
    }
    kept.push(block)
  }
  kept.push({ type: 'text', text: truncationNotice() })
  return kept
}

export async function truncateMcpContentIfNeeded(content: MCPToolResult): Promise<MCPToolResult> {
  if (await mcpContentNeedsTruncation(content)) return truncateMcpContent(content)
  return content
}
