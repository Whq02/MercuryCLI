import { ProtocolError, ProtocolErrorCode, Server, serveStdio, type Tool as McpTool } from '../services/mcp/sdk.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../Tool.js'
import { getSessionId } from '../bootstrap/state.js'
import { engageCommitGate } from '../guards/commitGate.js'
import { judgeToolCall } from '../guards/guards.js'
import { registerWardsGuard } from '../guards/wardsGuard.js'
import review from '../commands/review.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { getTools } from '../tools.js'
import { setCwd } from '../utils/Shell.js'
import { logError } from '../utils/log.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { isToolKilled } from '../utils/permissions/capabilityGate.js'
import { COMPUTER_TOOL_NAME } from '../services/desktop/toolName.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { randomUUID } from 'node:crypto'
import { zodToJsonSchema } from '../utils/zodToJsonSchema.js'
import { createAssistantMessage } from '../utils/messages.js'
import { repairToolInput } from '../services/providers/toolCallGate.js'
import { formatZodValidationError } from '../utils/toolErrors.js'

export function describeToolError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim()
    const name = error.name.trim()
    if (message === '') return name === '' ? 'Error' : name
    return name === '' || name === 'Error' || message.startsWith(`${name}:`) ? message : `${name}: ${message}`
  }
  const text = String(error).trim()
  return text === '' ? 'Error' : text
}

export function armServedSession(): void {
  registerWardsGuard(() => {}, getSessionId())
  engageCommitGate(getSessionId())
}

export async function servedCallRefusal(tool: Pick<Tool, 'name' | 'shellCommandOf'>, input: Record<string, unknown>, callId: string, signal?: AbortSignal): Promise<string | null> {
  const judgement = await judgeToolCall(getSessionId(), { tool: tool.name, input, callId, messages: [], toolRef: tool as Tool, asksAnswerable: false }, signal)
  return judgement.refused ? judgement.reason : null
}

export async function startMCPServer(
  cwd: string,
  debug: boolean,
): Promise<void> {
  const readFileStateCache = createFileStateCacheWithSizeLimit(100)

  setCwd(cwd)
  armServedSession()

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

  server.setRequestHandler('tools/list', async () => {
    const permissionContext = await buildServePermissionContext()
    const pool = getTools(permissionContext)
    const surviving = pool.filter(tool => !isToolKilled(tool) && tool.name !== COMPUTER_TOOL_NAME)
    const tools = await Promise.all(
      surviving.map(async tool => {
        const description = await tool.prompt({
          getToolPermissionContext: async () => permissionContext,
          tools: pool,
          agents: [],
        })
        const inputSchema = zodToJsonSchema(tool.inputSchema)
        const outputSchemaRaw = tool.outputSchema
          ? zodToJsonSchema(tool.outputSchema, 'output')
          : undefined
        const outputSchema =
          outputSchemaRaw &&
          typeof outputSchemaRaw === 'object' &&
          (outputSchemaRaw as { type?: string }).type === 'object'
            ? outputSchemaRaw
            : undefined
        const wire: McpTool = {
          name: tool.name,
          description,
          inputSchema: inputSchema as unknown as McpTool['inputSchema'],
          ...(outputSchema !== undefined ? { outputSchema: outputSchema as unknown as McpTool['outputSchema'] } : {}),
        }
        return wire
      }),
    )
    return { tools }
  })

  server.setRequestHandler('tools/call', async request => {
    const permissionContext = await buildServePermissionContext()
    const pool = getTools(permissionContext)
    const tool = pool.find(candidate => candidate.name === request.params.name && candidate.name !== COMPUTER_TOOL_NAME)
    if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`)
    const given = request.params.arguments
    if (given !== undefined && (given === null || typeof given !== 'object' || Array.isArray(given))) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${tool.name} takes an object of arguments`)
    }
    const parsed = tool.inputSchema.safeParse(repairToolInput(tool, (given ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, formatZodValidationError(tool.name, parsed.error, tool.inputJSONSchema))
    const args = parsed.data as Record<string, unknown>

    const abortController = new AbortController()
    const toolUseContext = {
      abortController,
      options: {
        commands: [review],
        tools: pool,
        engineModel: null as unknown as string,
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
      const validation = tool.validateInput
        ? await tool.validateInput(args as never, toolUseContext)
        : undefined
      if (validation && typeof validation === 'object' && validation.result === false) {
        throw new Error(
          `Tool ${tool.name} input validation failed: ${(validation as { message?: string }).message ?? 'invalid input'}`,
        )
      }
      const refusal = await servedCallRefusal(tool, args, randomUUID(), abortController.signal)
      if (refusal !== null) {
        throw new Error(`PermissionRefused: ${tool.name} — ${refusal}`)
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

  serveStdio(async () => server)
}
