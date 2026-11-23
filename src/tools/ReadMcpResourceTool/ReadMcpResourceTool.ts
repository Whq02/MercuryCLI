import { randomBytes } from 'node:crypto'
import { z } from 'zod/v4'

import { buildTool, type Tool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getBinaryBlobSavedMessage, persistBinaryContent } from '../../services/mcp/mcpOutputStorage.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT, READ_MCP_RESOURCE_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage, userFacingName } from './UI.js'
import { mcpClientForTools } from '../../services/mcp/client/forTools.js'
import { mcpServerDenyDecision } from '../../utils/permissions/ruleReason.js'
import { passedOver } from '../../utils/passedOver.js'


export const inputSchema = lazySchema(() =>
  z.strictObject({
    server: z.string().describe('The name of the MCP server to read the resource from'),
    uri: z.string().describe('The URI of the resource to read'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    contents: z
      .array(
        z.object({
          uri: z.string().describe("The resource entry's URI"),
          mimeType: z.string().optional().describe("The entry's MIME type"),
          text: z.string().optional().describe("The entry's text content"),
          blobSavedTo: z.string().optional().describe('Path a binary blob was saved to'),
        }),
      )
      .describe('The resource contents returned by the server'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
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

type Input = z.infer<InputSchema>

function isPersistError(
  result: Awaited<ReturnType<typeof persistBinaryContent>>,
): result is { error: string } {
  return Object.hasOwn(result, 'error')
}

async function projectEntry(
  entry: ResourceContent,
  index: number,
  server: string,
  requestedUri: string,
): Promise<OutputEntry> {
  const base: OutputEntry = { uri: entry.uri, mimeType: entry.mimeType }
  if (typeof entry.text === 'string') {
    return { ...base, text: entry.text }
  }
  if (typeof entry.blob !== 'string' || entry.blob.length === 0) {
    return base
  }
  const bytes = Buffer.from(entry.blob, 'base64')
  const persisted = await persistBinaryContent(bytes, entry.mimeType, persistIdFor(index))
  if (isPersistError(persisted)) {
    return { ...base, text: `Binary content could not be saved: ${persisted.error}` }
  }
  const savedText = getBinaryBlobSavedMessage(
    persisted.filepath,
    entry.mimeType,
    persisted.size,
    `MCP resource ${requestedUri} from server ${server}`,
  )
  return { ...base, blobSavedTo: persisted.filepath, text: savedText }
}

export const ReadMcpResourceTool: Tool<InputSchema, Output> = buildTool({
  name: READ_MCP_RESOURCE_TOOL_NAME,
  searchHint: 'read one MCP server resource by URI',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    const denied = mcpServerDenyDecision(
      context.getAppState().toolPermissionContext,
      READ_MCP_RESOURCE_TOOL_NAME,
      input.server,
    )
    if (denied !== null) return denied
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call({ server, uri }: Input, context: ToolUseContext) {
    const clients = context.options.mcpClients
    const client = clients.find(c => c.name === server)
    if (!client) {
      const names = clients.map(c => c.name).join(', ')
      throw new Error(`Server "${server}" not found. Available servers: ${names}`)
    }
    if (client.type !== 'connected') {
      throw new Error(`Server "${server}" is not connected`)
    }
    if (!client.capabilities?.resources) {
      throw new Error(`Server "${server}" does not support resources`)
    }
    const connected = await mcpClientForTools().ensureConnectedClient(client)
    const response: { contents?: readonly ResourceContent[] } = await connected.client.request({
      method: 'resources/read',
      params: { uri },
    })
    const rawContents = response.contents ?? []
    const contents = await Promise.all(
      rawContents.map((entry, index) => projectEntry(entry, index, server, uri)),
    )
    return { data: { contents } }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: JSON.stringify(output),
    }
  },
  extractSearchText(output: Output): string {
    if (!output || !Array.isArray(output.contents)) return ''
    try {
      return JSON.stringify(output.contents, null, 2)
    } catch (error) {
      passedOver(error)
      return ''
    }
  },
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(JSON.stringify(output, null, 2))
  },
  userFacingName,
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
