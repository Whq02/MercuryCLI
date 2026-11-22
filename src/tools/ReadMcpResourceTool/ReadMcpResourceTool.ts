import { randomBytes } from 'node:crypto'
import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getBinaryBlobSavedMessage, persistBinaryContent } from '../../services/mcp/mcpOutputStorage.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT, READ_MCP_RESOURCE_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage, userFacingName } from './UI.js'
import { mcpClientForTools } from '../../services/mcp/client/forTools.js'
import { mcpServerDenyDecision } from '../../utils/permissions/ruleReason.js'
import { passedOver } from '../../utils/passedOver.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


export const inputSchema: Unbuilt = unbuilt('src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts:15')

export const outputSchema: Unbuilt = unbuilt('src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts:24')
export type Output = Unbuilt
type OutputEntry = Output['contents'][number]

type ResourceContent = {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

function persistIdFor(index: number): string {
  return `mcp-resource-${Date.now()}-${index}-${randomBytes(4).toString('hex')}`
}

export const ReadMcpResourceTool: Unbuilt = unbuilt('src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts:90')
