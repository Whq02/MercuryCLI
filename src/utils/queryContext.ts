import { getSystemContext, getUserContext } from '../context.js'
import { getSystemPrompt } from '../constants/prompts.js'
import type { Command } from '../commands.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../types/message.js'
import type { InternalPermissionMode } from '../types/permissions.js'
import type { CacheSafeParams } from './forkedAgent.js'
import type { FileStateCache } from './fileStateCache.js'
import { createAbortController } from './abortController.js'
import { getEngineModel } from './model/model.js'
import { asSystemPrompt } from './systemPromptType.js'
import { shouldEnableThinkingByDefault, type ThinkingConfig } from './thinking.js'

type PromptInputs = {
  tools: Tools; engineModel: string; mcpClients: MCPServerConnection[]
  customSystemPrompt?: string; permissionMode?: InternalPermissionMode
}
type PromptParts = {
  defaultSystemPrompt: string[]; userContext: Record<string, string>; systemContext: Record<string, string>
}
type ForkInputs = {
  tools: Tools; commands: Command[]; mcpClients: MCPServerConnection[]; messages: Message[]
  readFileState: FileStateCache; getAppState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
  customSystemPrompt?: string; appendSystemPrompt?: string; thinkingConfig?: ThinkingConfig
  agents: AgentDefinition[]
}

export async function fetchSystemPromptParts(input: PromptInputs): Promise<PromptParts> {
  if (input.customSystemPrompt !== undefined) {
    return { defaultSystemPrompt: [], userContext: await getUserContext(), systemContext: {} }
  }
  const pending = {
    defaultSystemPrompt: getSystemPrompt(input.tools, input.engineModel, input.mcpClients, input.permissionMode),
    userContext: getUserContext(), systemContext: getSystemContext(),
  }
  const [prompt, user, system] = await Promise.all([pending.defaultSystemPrompt, pending.userContext, pending.systemContext])
  return { defaultSystemPrompt: prompt, userContext: user, systemContext: system }
}

function settledForkMessages(messages: Message[]): Message[] {
  const tail = messages.at(-1)
  return tail?.type === 'assistant' && tail.message.stop_reason === null ? messages.slice(0, -1) : messages
}

function forkContext(input: ForkInputs, engineModel: string, messages: Message[], thinkingConfig: ThinkingConfig): ToolUseContext {
  const options: ToolUseContext['options'] = {
    commands: input.commands, debug: false, verbose: false, engineModel,
    tools: input.tools, thinkingConfig, mcpClients: input.mcpClients, mcpResources: {},
    isNonInteractiveSession: true, agentDefinitions: { activeAgents: input.agents, allAgents: [] },
    customSystemPrompt: input.customSystemPrompt, appendSystemPrompt: input.appendSystemPrompt,
  }
  return {
    options, abortController: createAbortController(), readFileState: input.readFileState,
    getAppState: input.getAppState, setAppState: input.setAppState,
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {},
    updateFileHistoryState: () => {}, updateAttributionState: () => {}, messages,
  }
}

export async function buildSideQuestionFallbackParams(input: ForkInputs): Promise<CacheSafeParams> {
  const engineModel = getEngineModel()
  const appState = input.getAppState()
  const parts = await fetchSystemPromptParts({
    tools: input.tools, engineModel, mcpClients: input.mcpClients,
    customSystemPrompt: input.customSystemPrompt, permissionMode: appState.toolPermissionContext.mode,
  })
  const selected = input.customSystemPrompt === undefined ? parts.defaultSystemPrompt : [input.customSystemPrompt]
  const systemPrompt = asSystemPrompt(input.appendSystemPrompt ? selected.concat(input.appendSystemPrompt) : selected)
  const forkContextMessages = settledForkMessages(input.messages)
  const thinking = input.thinkingConfig ?? { type: shouldEnableThinkingByDefault() ? 'adaptive' : 'disabled' }
  return {
    systemPrompt, userContext: parts.userContext, systemContext: parts.systemContext,
    toolUseContext: forkContext(input, engineModel, forkContextMessages, thinking), forkContextMessages,
  }
}
