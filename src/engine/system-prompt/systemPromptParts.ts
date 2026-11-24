import { getSystemContext, getUserContext } from '../requestContext.js'
import { getSystemPrompt } from './defaultSystemPrompt.js'
import { turnDoor } from '../turnDoor.js'
import type { Command } from '../../commands/catalogue/commands.js'
import type { MCPServerConnection } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import type { AppState } from '../../screen/app-state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../../tools/kit/tool.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import type { Message } from '../message-shapes/message.js'
import type { InternalPermissionMode } from '../../permissions/rules/permissions.js'
import type { CacheSafeParams } from '../../crew/agents/forkedAgent.js'
import type { FileStateCache } from '../../platform/files/fileStateCache.js'
import { createAbortController } from '../../platform/async/abortController.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { asSystemPrompt } from './systemPromptType.js'
import { shouldEnableThinkingByDefault, type ThinkingConfig } from '../../models/effort/thinking.js'

type PromptInputs = {
  tools: Tools; engineModel: string; mcpClients: MCPServerConnection[]
  customSystemPrompt?: string; permissionMode?: InternalPermissionMode
  memoryTask?: import('../../sessions/mneme/entryKnapsack.js').StartTask
}
type PromptParts = {
  defaultSystemPrompt: string[]; userContext: Record<string, string>; systemContext: Record<string, string>
}
type ForkInputs = {
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  messages: Message[]
  readFileState: FileStateCache
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  customSystemPrompt?: string
  appendSystemPrompt?: string
  thinkingConfig?: ThinkingConfig
  agents?: AgentDefinition[]
}

export async function fetchSystemPromptParts(input: PromptInputs): Promise<PromptParts> {
  if (input.customSystemPrompt !== undefined) {
    return { defaultSystemPrompt: [], userContext: await getUserContext(), systemContext: {} }
  }
  const pending = {
    defaultSystemPrompt: getSystemPrompt(input.tools, input.engineModel, input.mcpClients, input.permissionMode, input.memoryTask),
    userContext: getUserContext(), systemContext: getSystemContext(),
  }
  const [prompt, user, system] = await Promise.all([pending.defaultSystemPrompt, pending.userContext, pending.systemContext])
  return { defaultSystemPrompt: prompt, userContext: user, systemContext: system }
}

function settledForkMessages(messages: Message[]): Message[] {
  let end = messages.length
  while (end > 0) {
    const last = messages[end - 1]!
    if (last.type === 'assistant' && last.message.stop_reason === null) {
      end--
    } else {
      break
    }
  }
  return end === messages.length ? messages : messages.slice(0, end)
}

export async function buildSideQuestionFallbackParams(input: ForkInputs): Promise<CacheSafeParams> {
  const {
    tools,
    commands,
    mcpClients,
    messages,
    readFileState,
    getAppState,
    setAppState,
    customSystemPrompt,
    appendSystemPrompt,
    thinkingConfig,
    agents,
  } = input

  const engineModel = getEngineModel()
  const appState = getAppState()
  const { defaultSystemPrompt, userContext, systemContext } = await fetchSystemPromptParts({
    tools,
    engineModel,
    mcpClients,
    customSystemPrompt,
    permissionMode: appState.toolPermissionContext.mode,
  })

  const promptSections = customSystemPrompt !== undefined ? [customSystemPrompt] : [...defaultSystemPrompt]
  if (appendSystemPrompt) {
    promptSections.push(appendSystemPrompt)
  }
  const systemPrompt = asSystemPrompt(promptSections)

  const forkContextMessages = settledForkMessages(messages)
  const resolvedThinkingConfig: ThinkingConfig =
    thinkingConfig ?? (shouldEnableThinkingByDefault() ? { type: 'adaptive' } : { type: 'disabled' })

  const toolUseContext: ToolUseContext = {
    options: {
      commands,
      debug: false,
      verbose: false,
      engineModel,
      tools,
      mcpClients,
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: agents ?? [] },
      thinkingConfig: resolvedThinkingConfig,
      ...(customSystemPrompt !== undefined ? { customSystemPrompt } : {}),
      ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
    },
    startTurn: turnDoor,
    abortController: createAbortController(),
    readFileState,
    getAppState,
    setAppState,
    messages: forkContextMessages,
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
  }

  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages,
  }
}
