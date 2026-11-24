import { ProtocolError, ProtocolErrorCode, Server, serveStdio, type Tool as McpTool } from '../mcp-shapes/sdk.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../tools/kit/tool.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { turnDoor } from '../../engine/turnDoor.js'
import { engageCommitGate } from '../../permissions/guards/commitGate.js'
import { judgeToolCall } from '../../permissions/guards/guards.js'
import { registerWardsGuard } from '../../permissions/guards/wardsGuard.js'
import review from '../../commands/review/index.js'
import { getDefaultAppState } from '../../screen/app-state/AppStateStore.js'
import { getTools } from '../../tools/kit/toolList.js'
import { setCwd } from '../../platform/shell/shellExec.js'
import { logError } from '../../platform/logs/errorLog.js'
import { hasPermissionsToUseTool } from '../../permissions/rules/permissionDoor.js'
import { isToolKilled } from '../../permissions/rules/capabilityGate.js'
import { COMPUTER_TOOL_NAME } from '../desktop/toolName.js'
import { createFileStateCacheWithSizeLimit } from '../../platform/files/fileStateCache.js'
import { randomUUID } from 'node:crypto'
import { zodToJsonSchema } from '../../platform/primitives/zodToJsonSchema.js'
import { createAssistantMessage } from '../../engine/messages/messages.js'
import { repairToolInput } from '../../models/roads/toolCallGate.js'
import { isRecord } from '../../platform/primitives/isRecord.js'
import { formatZodValidationError } from '../../tools/kit/toolErrors.js'

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

export async function buildServePermissionContext(): Promise<ReturnType<typeof getEmptyToolPermissionContext>> {
  const context = getEmptyToolPermissionContext()
  const { loadAllPermissionRulesFromDisk } = await import('../../permissions/rules/permissionsLoader.js')
  const { applyPermissionRulesToPermissionContext } = await import('../../permissions/rules/permissionDoor.js')
  return applyPermissionRulesToPermissionContext(context, loadAllPermissionRulesFromDisk())
}

export async function startMCPServer(
  cwd: string,
  debug: boolean,
): Promise<void> {
  const { registerBootDoors } = await import('../../boot/doors/registerDoors.js')
  registerBootDoors()

  const readFileState = createFileStateCacheWithSizeLimit(100)
  setCwd(cwd)
  armServedSession()

  const server = new Server(
    {
      name: 'mercury',
      version: MACRO.VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler('tools/list', async () => {
    const toolPermissionContext = await buildServePermissionContext()
    const pool = getTools(toolPermissionContext)
    const eligible = pool.filter(tool => !isToolKilled(tool) && tool.name !== COMPUTER_TOOL_NAME)
    const tools: McpTool[] = await Promise.all(
      eligible.map(async tool => {
        const description = await tool.prompt({
          getToolPermissionContext: async () => toolPermissionContext,
          tools: pool,
          agents: [],
        })
        const inputSchema = zodToJsonSchema(tool.inputSchema) as McpTool['inputSchema']
        const convertedOutput = tool.outputSchema ? zodToJsonSchema(tool.outputSchema, 'output') : undefined
        const outputSchema =
          convertedOutput !== undefined && convertedOutput.type === 'object'
            ? convertedOutput
            : undefined
        return {
          name: tool.name,
          description,
          inputSchema,
          ...(outputSchema !== undefined ? { outputSchema } : {}),
        }
      }),
    )
    return { tools }
  })

  server.setRequestHandler('tools/call', async request => {
    const toolPermissionContext = await buildServePermissionContext()
    const pool = getTools(toolPermissionContext)
    const tool = pool.find(item => item.name === request.params.name && item.name !== COMPUTER_TOOL_NAME)
    if (!tool) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`)
    }

    const rawArgs: unknown = request.params.arguments
    if (rawArgs !== undefined && !isRecord(rawArgs)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${tool.name} takes an object of arguments`)
    }

    const repaired = repairToolInput(tool, rawArgs ?? {})
    const parsed = tool.inputSchema.safeParse(repaired)
    if (!parsed.success) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        formatZodValidationError(tool.name, parsed.error, tool.inputSchema),
      )
    }
    if (!isRecord(parsed.data)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${tool.name} takes an object of arguments`)
    }
    const parsedArgs = parsed.data
    const abortController = new AbortController()
    const toolUseContext: ToolUseContext = {
      abortController,
      startTurn: turnDoor,
      options: {
        commands: [review],
        tools: pool,
        engineModel: '',
        maxThinkingTokens: 0,
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        debug,
        verbose: false,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      getAppState: () => ({
        ...getDefaultAppState(),
        toolPermissionContext,
      }),
      setAppState: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      messages: [],
      readFileState,
    }

    try {
      if (!tool.isEnabled()) {
        throw new Error(`Tool ${tool.name} is not enabled`)
      }
      if (isToolKilled(tool)) {
        throw new Error(`CapabilityKilled: ${tool.name}`)
      }
      if (tool.validateInput) {
        const validation = await tool.validateInput(parsedArgs, toolUseContext)
        if (!validation.result) {
          throw new Error(`Tool ${tool.name} input validation failed: ${validation.message || 'invalid input'}`)
        }
      }
      const refusal = await servedCallRefusal(tool, parsedArgs, randomUUID(), abortController.signal)
      if (refusal !== null) {
        throw new Error(`PermissionRefused: ${tool.name} — ${refusal}`)
      }
      const assistantMessage = createAssistantMessage({ content: [] })
      const decision = await hasPermissionsToUseTool(
        tool,
        parsedArgs,
        toolUseContext,
        assistantMessage,
        randomUUID(),
      )
      if (decision.behavior !== 'allow') {
        throw new Error(`PermissionRefused: ${tool.name} — ${decision.message}`)
      }
      const result = await tool.call(
        decision.updatedInput ?? parsedArgs,
        toolUseContext,
        hasPermissionsToUseTool,
        assistantMessage,
      )
      const text = typeof result === 'string' ? result : JSON.stringify(result.data)
      return {
        content: [{ type: 'text', text }],
      }
    } catch (error) {
      logError(error)
      return {
        isError: true,
        content: [{ type: 'text', text: describeToolError(error) }],
      }
    }
  })

  serveStdio(async () => server)
}
