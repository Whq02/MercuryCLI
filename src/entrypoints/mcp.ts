// ============================================================================
//  src/entrypoints/mcp.ts — the stdio MCP server that re-exposes Mercury's
//  builtin tool pool to an external MCP client. Every Mercury-owned MCP
//  surface identifies as Mercury — an identity requirement.
// ============================================================================
import { Server } from '../services/mcp/sdk.js'
import { StdioServerTransport } from '../services/mcp/sdk.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '../services/mcp/sdk.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../Tool.js'
import review from '../commands/review.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { getTools } from '../tools.js'
import { setCwd } from '../utils/Shell.js'
import { logError } from '../utils/log.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { isToolKilled } from '../utils/permissions/capabilityGate.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { randomUUID } from 'node:crypto'
import { zodToJsonSchema } from '../utils/zodToJsonSchema.js'
import { createAssistantMessage } from '../utils/messages.js'

/** Decompose an error into its non-empty parts, joined by newlines; the
 *  literal `Error` when everything is empty. */
function describeToolError(error: unknown): string {
  if (error instanceof Error) {
    const parts = [error.name, error.message, error.stack]
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
      .filter((part, index, all) => all.indexOf(part) === index)
    const joined = parts.join('\n').trim()
    return joined === '' ? 'Error' : joined
  }
  const text = String(error).trim()
  return text === '' ? 'Error' : text
}

export async function startMCPServer(
  cwd: string,
  debug: boolean,
  verbose: boolean,
): Promise<void> {
  // A size-limited LRU bounds read-file-state memory. ONE parameter: the
  // 100-file limit (a 25 MB figure exists only as recorded rationale beside
  // it, not as an argument).
  const readFileStateCache = createFileStateCacheWithSizeLimit(100)

  setCwd(cwd)

  const server = new Server(
    { name: 'mercury', version: MACRO.VERSION },
    { capabilities: { tools: {} } },
  )

  // Scope note: no agent type is passed and this entrypoint never sets a
  // main-thread agent type, so kill probes resolve to the all-agents key —
  // only bare or wildcard kills are enforced, the conservative behaviour
  // since there is no per-agent dispatch on this surface.
  // The serve surface enforces the operator's DISK rules (FC-026): the
  // empty context advertised and executed settings-denied tools. Rules load
  // per request (cheap through the settings cache) so a settings edit
  // applies without restarting the server; a load failure degrades to the
  // empty context — never a crash, and the deny gap is at worst what it
  // always was.
  const buildServePermissionContext = async (): Promise<ReturnType<typeof getEmptyToolPermissionContext>> => {
    const context = getEmptyToolPermissionContext()
    try {
      const { loadAllPermissionRulesFromDisk } = await import('../utils/permissions/permissionsLoader.js')
      const { applyPermissionRulesToPermissionContext } = await import('../utils/permissions/permissions.js')
      return applyPermissionRulesToPermissionContext(context, loadAllPermissionRulesFromDisk())
    } catch {
      return context
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const permissionContext = await buildServePermissionContext()
    const pool = getTools(permissionContext)
    // A killed tool must never even be ADVERTISED here, mirroring the
    // execution deny below.
    const surviving = pool.filter(tool => !isToolKilled(tool))
    const tools = await Promise.all(
      surviving.map(async tool => {
        const description = await tool.prompt({
          getToolPermissionContext: async () => permissionContext,
          tools: pool,
          agents: [],
        })
        const inputSchema = zodToJsonSchema(tool.inputSchema)
        const outputSchemaRaw = tool.outputSchema
          ? zodToJsonSchema(tool.outputSchema)
          : undefined
        // Root-level anyOf/oneOf shapes are dropped: the MCP SDK requires
        // an object root.
        const outputSchema =
          outputSchemaRaw &&
          typeof outputSchemaRaw === 'object' &&
          (outputSchemaRaw as { type?: string }).type === 'object'
            ? outputSchemaRaw
            : undefined
        return {
          ...tool,
          name: tool.name,
          description,
          inputSchema,
          ...(outputSchema !== undefined ? { outputSchema } : {}),
        }
      }),
    )
    return { tools }
  })

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const permissionContext = await buildServePermissionContext()
    const pool = getTools(permissionContext)
    const tool = pool.find(candidate => candidate.name === request.params.name)
    if (!tool) throw new Error(`Tool ${request.params.name} not found`)

    const abortController = new AbortController()
    const toolUseContext = {
      abortController,
      options: {
        commands: [review],
        tools: pool,
        // No main loop exists on the serve surface; consumers treat the
        // absent model as opaque.
        mainLoopModel: null as unknown as string,
        maxThinkingTokens: 0,
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        debug,
        verbose,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      // The serve context, not the default state's: per-call enforcement
      // below and any in-call consumer must judge against the same rules
      // the pool was assembled from.
      getAppState: () => ({ ...getDefaultAppState(), toolPermissionContext: permissionContext }),
      setAppState: () => {},
      messages: [],
      readFileState: readFileStateCache,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
    } satisfies ToolUseContext

    try {
      if (!tool.isEnabled()) {
        throw new Error(`Tool ${tool.name} is not enabled`)
      }
      // This path calls the tool DIRECTLY rather than through the
      // permission-and-call wrapper, so the kill must be enforced here too
      // or a killed builtin would still execute over MCP, defeating the
      // bypass-immunity guarantee. Alias-aware; an empty kill store no-ops.
      if (isToolKilled(tool)) {
        throw new Error(`CapabilityKilled: ${tool.name}`)
      }
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      const validation = tool.validateInput
        ? await tool.validateInput(args, toolUseContext)
        : undefined
      if (validation && typeof validation === 'object' && validation.result === false) {
        throw new Error(
          `Tool ${tool.name} input validation failed: ${(validation as { message?: string }).message ?? 'invalid input'}`,
        )
      }
      // Pool membership alone is not containment: a tool that survives the
      // deny filter still has per-call boundaries (a Read outside the served
      // directory must refuse). The serve surface is unattended, so it takes
      // the headless posture — the full ladder decides, and anything short
      // of allow refuses, because an ask here has no one to ask. Operators
      // widen deliberately via standing allow rules, which this road loads.
      const assistantMessage = createAssistantMessage({ content: '' })
      const decision = await hasPermissionsToUseTool(
        tool,
        args,
        toolUseContext,
        assistantMessage,
        randomUUID(),
      )
      if (decision.behavior !== 'allow') {
        throw new Error(`PermissionRefused: ${tool.name} — ${decision.message}`)
      }
      const result = await tool.call(
        (decision.updatedInput as Record<string, unknown> | undefined) ?? args,
        toolUseContext,
        hasPermissionsToUseTool,
        assistantMessage,
      )
      return {
        content: [
          {
            type: 'text',
            text:
              typeof result === 'string'
                ? result
                : JSON.stringify((result as { data?: unknown }).data),
          },
        ],
      }
    } catch (error) {
      logError(error)
      return {
        content: [{ type: 'text', text: describeToolError(error) }],
        isError: true,
      }
    }
  })

  const transport = new StdioServerTransport()
  return await server.connect(transport)
}
