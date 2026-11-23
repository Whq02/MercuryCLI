import { getSystemContext, getUserContext } from '../../context.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { query } from '../../query.js'
import type { Command } from '../../commands.js'
import type { MCPServerConnection } from '../../utils/mcp/types.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from '../../types/agent.js'
import type { Message } from '../../types/message.js'
import type { InternalPermissionMode } from '../../types/permissions.js'
import type { CacheSafeParams } from './forkedAgent.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import { createAbortController } from '../../utils/abortController.js'
import { getEngineModel } from '../model/model.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { shouldEnableThinkingByDefault, type ThinkingConfig } from '../../utils/thinking.js'

type PromptInputs = {
  tools: Tools; engineModel: string; mcpClients: MCPServerConnection[]
  customSystemPrompt?: string; permissionMode?: InternalPermissionMode
  memoryTask?: import('../../mneme/entryKnapsack.js').StartTask
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
    startTurn: query,
    abortController: createAbortController(),
    readFileState,
    getAppState,
    setAppState,
    messages: forkContextMessages,
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }

  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages,
  }
}
