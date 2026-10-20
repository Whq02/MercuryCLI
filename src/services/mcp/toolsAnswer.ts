import type { McpToolEntryV1, McpToolLoadingV1, McpToolsStateV1, McpToolsV1 } from '../../daemon/protocol.js'
import type { ResultOf } from '../../runner/wire/methods.js'

type McpToolsWireAnswer = ResultOf<'mcp/tools'>
type McpToolsWireEntry = McpToolsWireAnswer['tools'][number]

export const MCP_TOOLS_ANSWER_BYTES = 512 * 1024
export const MCP_TOOL_DESCRIPTION_CHARS = 8192

const WITHHELD_MARK_BYTES = ',"schema_withheld_bytes":'.length + 16

export type McpToolFacts = {
  name: string
  registeredAs: string
  description: string
  inputSchema: Record<string, unknown>
  loading: McpToolLoadingV1
}

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

export function mcpToolsAnswerOf(server: string, tools: readonly McpToolFacts[], budget: number = MCP_TOOLS_ANSWER_BYTES): McpToolsWireAnswer {
  const entries: McpToolsWireEntry[] = []
  let used = bytesOf({ server, state: 'connected', tools: [], omitted: tools.length })
  for (const tool of tools) {
    const chars = Array.from(tool.description)
    const cut = chars.length > MCP_TOOL_DESCRIPTION_CHARS
    const entry: McpToolsWireEntry = {
      name: tool.name,
      registered_as: tool.registeredAs,
      description: cut ? `${chars.slice(0, MCP_TOOL_DESCRIPTION_CHARS).join('')}…` : tool.description,
      ...(cut ? { description_cut: true as const } : {}),
      input_schema: {},
      loading: tool.loading,
    }
    const size = bytesOf(entry) + 1 + WITHHELD_MARK_BYTES
    if (used + size > budget) break
    used += size
    entries.push(entry)
  }
  const schemaBytes = entries.map((_, index) => bytesOf(tools[index]!.inputSchema))
  const smallestFirst = entries.map((_, index) => index).sort((a, b) => schemaBytes[a]! - schemaBytes[b]! || a - b)
  for (const index of smallestFirst) {
    const grows = schemaBytes[index]! - 2 - WITHHELD_MARK_BYTES
    if (used + grows <= budget) {
      entries[index] = { ...entries[index]!, input_schema: tools[index]!.inputSchema }
      used += grows
    } else {
      entries[index] = { ...entries[index]!, schema_withheld_bytes: schemaBytes[index]! }
    }
  }
  return { server, state: 'connected', tools: entries, omitted: tools.length - entries.length }
}

export function mcpToolsUnlistedAnswer(server: string, client: { type: string; error?: string } | undefined): McpToolsWireAnswer {
  if (client === undefined) return { server, state: 'absent', tools: [], omitted: 0, detail: `this session has no MCP server named ${server}` }
  if (client.type === 'needs-auth') return { server, state: 'needs-auth', tools: [], omitted: 0, detail: `${server} needs sign-in before its tools can be listed — ↵ on its row signs in` }
  if (client.type === 'failed') return { server, state: 'failed', tools: [], omitted: 0, detail: `${server} failed: ${client.error !== undefined && client.error !== '' ? client.error : 'connection failed'}` }
  if (client.type === 'disabled') return { server, state: 'disabled', tools: [], omitted: 0, detail: `${server} is off for this session — its tools are not in the session` }
  return { server, state: 'pending', tools: [], omitted: 0, detail: `${server} is still connecting — its tools are listed once it connects` }
}

export function mcpToolsFromWire(answer: McpToolsWireAnswer): McpToolsV1 {
  return {
    server: answer.server,
    state: answer.state,
    tools: answer.tools.map(tool => ({
      name: tool.name,
      registeredAs: tool.registered_as,
      description: tool.description,
      ...(tool.description_cut === true ? { descriptionCut: true as const } : {}),
      inputSchema: tool.input_schema,
      ...(tool.schema_withheld_bytes !== undefined ? { schemaWithheldBytes: tool.schema_withheld_bytes } : {}),
      loading: tool.loading,
    })),
    omitted: answer.omitted,
    ...(answer.detail !== undefined ? { detail: answer.detail } : {}),
  }
}

const STATES: readonly McpToolsStateV1[] = ['connected', 'needs-auth', 'failed', 'disabled', 'pending', 'absent', 'unavailable']
const LOADINGS: readonly McpToolLoadingV1[] = ['deferred', 'listed', 'held']

function entryOfReply(value: unknown): McpToolEntryV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.name !== 'string' || typeof row.registeredAs !== 'string' || typeof row.description !== 'string') return null
  if (typeof row.inputSchema !== 'object' || row.inputSchema === null || Array.isArray(row.inputSchema)) return null
  if (!LOADINGS.includes(row.loading as McpToolLoadingV1)) return null
  return {
    name: row.name,
    registeredAs: row.registeredAs,
    description: row.description,
    ...(row.descriptionCut === true ? { descriptionCut: true as const } : {}),
    inputSchema: row.inputSchema as Record<string, unknown>,
    ...(typeof row.schemaWithheldBytes === 'number' && Number.isFinite(row.schemaWithheldBytes) ? { schemaWithheldBytes: row.schemaWithheldBytes } : {}),
    loading: row.loading as McpToolLoadingV1,
  }
}

export function mcpToolsOfReply(value: unknown): McpToolsV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const answer = value as Record<string, unknown>
  if (typeof answer.server !== 'string' || !STATES.includes(answer.state as McpToolsStateV1) || !Array.isArray(answer.tools)) return null
  const tools = answer.tools.map(entryOfReply)
  if (tools.some(tool => tool === null)) return null
  const omitted = typeof answer.omitted === 'number' && Number.isInteger(answer.omitted) && answer.omitted >= 0 ? answer.omitted : 0
  return {
    server: answer.server,
    state: answer.state as McpToolsStateV1,
    tools: tools as McpToolEntryV1[],
    omitted,
    ...(typeof answer.detail === 'string' && answer.detail !== '' ? { detail: answer.detail } : {}),
  }
}
