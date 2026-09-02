import { randomBytes } from 'node:crypto'
import { ReadResourceResultSchema } from '../../services/mcp/sdk.js'
import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { ensureConnectedClient } from '../../services/mcp/client.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getBinaryBlobSavedMessage, persistBinaryContent } from '../../utils/mcpOutputStorage.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage, userFacingName } from './UI.js'

/**
 * Reads one MCP resource by (server, uri). Binary payloads are intercepted
 * and persisted to disk so base-64 bytes never reach the model context.
 */

/** The tool name is transcript contract data. */
const READ_MCP_RESOURCE_TOOL_NAME = 'ReadMcpResourceTool'

export const inputSchema = lazySchema(() =>
  z.strictObject({
    server: z.string().describe('The name of the MCP server to read the resource from'),
    uri: z.string().describe('The URI of the resource to read'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    contents: z
      .array(
        z.object({
          uri: z.string().describe('The resource entry\'s URI'),
          mimeType: z.string().optional().describe('The entry\'s MIME type'),
          text: z.string().optional().describe('The entry\'s text content'),
          blobSavedTo: z
            .string()
            .optional()
            .describe('Path a binary blob was saved to'),
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

/**
 * A per-entry identifier unique across concurrent reads: timestamp, entry
 * index and a random component.
 */
function persistIdFor(index: number): string {
  return `mcp-resource-${Date.now()}-${index}-${randomBytes(4).toString('hex')}`
}

async function projectEntry(
  entry: ResourceContent,
  index: number,
  serverName: string,
  uri: string,
): Promise<OutputEntry> {
  if (typeof entry.text === 'string') {
    return { uri: entry.uri, mimeType: entry.mimeType, text: entry.text }
  }
  if (typeof entry.blob !== 'string' || entry.blob.length === 0) {
    return { uri: entry.uri, mimeType: entry.mimeType }
  }
  const bytes = Buffer.from(entry.blob, 'base64')
  const persisted = await persistBinaryContent(bytes, entry.mimeType, persistIdFor(index))
  if ('error' in persisted) {
    return {
      uri: entry.uri,
      mimeType: entry.mimeType,
      text: `Binary content could not be saved: ${persisted.error}`,
    }
  }
  return {
    uri: entry.uri,
    mimeType: entry.mimeType,
    blobSavedTo: persisted.filepath,
    text: getBinaryBlobSavedMessage(
      persisted.filepath,
      entry.mimeType,
      persisted.size,
      `MCP resource ${uri} from server ${serverName}`,
    ),
  }
}

export const ReadMcpResourceTool = buildTool({
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
  userFacingName,
  toAutoClassifierInput(input: Input): string {
    return `${input.server} ${input.uri}`
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  async call({ server, uri }: Input, context: ToolUseContext) {
    const clients = context.options.mcpClients
    const client = clients.find(candidate => candidate.name === server)
    if (!client) {
      throw new Error(
        `Server "${server}" not found. Available servers: ${clients.map(candidate => candidate.name).join(', ')}`,
      )
    }
    if (client.type !== 'connected') {
      throw new Error(`Server "${server}" is not connected`)
    }
    if (!client.capabilities?.resources) {
      throw new Error(`Server "${server}" does not support resources`)
    }
    const live = await ensureConnectedClient(client)
    const result = await live.client.request(
      { method: 'resources/read', params: { uri } },
      ReadResourceResultSchema,
    )
    // Every entry is processed concurrently; output order matches input order.
    const contents = await Promise.all(
      (result.contents as ResourceContent[]).map((entry, index) =>
        projectEntry(entry, index, server, uri),
      ),
    )
    return { data: { contents } satisfies Output }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: JSON.stringify(output),
    }
  },
  extractSearchText(output: Output): string {
    try {
      return Array.isArray(output?.contents) ? JSON.stringify(output.contents, null, 2) : ''
    } catch {
      return ''
    }
  },
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(JSON.stringify(output, null, 2))
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
