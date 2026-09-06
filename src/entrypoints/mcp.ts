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
): Promise<void> {
  const readFileStateCache = createFileStateCacheWithSizeLimit(100)

  setCwd(cwd)

  const server = new Server(
    { name: 'mercury', version: MACRO.VERSION },
    { capabilities: { tools: {} } },
  )

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
        mainLoopModel: null as unknown as string,
        maxThinkingTokens: 0,
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        debug,
        verbose: false,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
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
