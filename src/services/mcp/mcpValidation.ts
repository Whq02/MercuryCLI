import { flagEnv } from '../../substrate/flagRegistry.js'
import { countMessagesTokensWithAPI, roughTokenCountEstimation } from '../tokenEstimation.js'
import type { ContentBlockParam, ImageBlockParam, MessageParam, TextBlockParam } from '../../types/wire.js'
import { compressImageBlock } from '../../utils/imageResizer.js'
import { logError } from '../../utils/log.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


const MCP_TOKEN_COUNT_THRESHOLD_FACTOR = 0.5
const IMAGE_TOKEN_ESTIMATE = 1600

const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25_000

export type MCPToolResult = Unbuilt

export function getMaxMcpOutputTokens(): number {
  return notBuilt('src/services/mcp/mcpValidation.ts:16')
}

export function getContentSizeEstimate(content: MCPToolResult): number {
  return notBuilt('src/services/mcp/mcpValidation.ts:26')
}

export async function mcpContentNeedsTruncation(content: MCPToolResult): Promise<boolean> {
  return notBuilt('src/services/mcp/mcpValidation.ts:37')
}

export async function truncateMcpContent(content: MCPToolResult): Promise<MCPToolResult> {
  return notBuilt('src/services/mcp/mcpValidation.ts:61')
}
