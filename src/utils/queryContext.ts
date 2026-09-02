import { getSystemContext, getUserContext } from '../context.js'
import { getSystemPrompt } from '../constants/prompts.js'
import type { Command } from '../commands.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type { ToolUseContext } from '../Tool.js'
import type { Tools } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { createAbortController } from './abortController.js'
import type { CacheSafeParams } from './forkedAgent.js'
import type { FileStateCache } from './fileStateCache.js'
import { getMainLoopModel } from './model/model.js'
import { asSystemPrompt } from './systemPromptType.js'
import type { ThinkingConfig } from './thinking.js'
import { shouldEnableThinkingByDefault } from './thinking.js'

/**
 * The API cache-key prefix (system prompt parts, user context, system
 * context) and the side-question fallback parameter bundle.
 *
 * A separate file for DEPENDENCY-GRAPH reasons that are part of its
 * contract: the context and prompt builders sit near the top of the import
 * graph, and both modules that would otherwise host these functions are
 * reachable from the command registry — importing the builders there closes
 * a cycle. Only entry-point-layer callers (the query engine and the
 * headless runner) may import this module.
 */

/**
 * A custom system prompt is a WHOLESALE substitute: both the default prompt
 * build and the system-context fetch are skipped (the system context is a
 * companion of the default prompt specifically). User context is always
 * fetched.
 */
export async function fetchSystemPromptParts({
  tools,
  mainLoopModel,
  additionalWorkingDirectories,
  mcpClients,
  customSystemPrompt,
  permissionMode,
}: {
  tools: Tools
  mainLoopModel: string
  additionalWorkingDirectories: string[]
  mcpClients: MCPServerConnection[]
  customSystemPrompt?: string
  /** The LIVE toolPermissionContext.mode — the mode packs (apollo, autopilot)
   *  compose into the prompt only when the caller threads it (the next-turn
   *  law: a mode flipped between turns speaks on the very next build). */
  permissionMode?: import('../types/permissions.js').InternalPermissionMode
}): Promise<{ defaultSystemPrompt: string[]; userContext: { [k: string]: string }; systemContext: { [k: string]: string } }> {
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([] as string[])
      : getSystemPrompt(tools, mainLoopModel, additionalWorkingDirectories, mcpClients, permissionMode),
    getUserContext(),
    customSystemPrompt !== undefined ? Promise.resolve({} as { [k: string]: string }) : getSystemContext(),
  ])
  return { defaultSystemPrompt, userContext, systemContext }
}

/**
 * The fallback cache-safe bundle for a side question fired before any turn
 * has completed: the same system-prompt assembly the engine does, so the
 * fork's first request hits the cache the main loop primes. Material the
 * engine adds that this path cannot see (coordinator user context, the
 * memory-mechanics prompt) is an accepted cache miss.
 */
export async function buildSideQuestionFallbackParams({
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
}: {
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  messages: Message[]
  readFileState: FileStateCache
  getAppState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
  customSystemPrompt?: string
  appendSystemPrompt?: string
  thinkingConfig?: ThinkingConfig
  agents: AgentDefinition[]
}): Promise<CacheSafeParams> {
  const mainLoopModel = getMainLoopModel()
  const appState = getAppState()
  const additionalWorkingDirectories = Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys())
  const { defaultSystemPrompt, userContext, systemContext } = await fetchSystemPromptParts({
    tools,
    mainLoopModel,
    additionalWorkingDirectories,
    mcpClients,
    customSystemPrompt,
    permissionMode: appState.toolPermissionContext.mode,
  })
  const promptParts = customSystemPrompt !== undefined ? [customSystemPrompt] : defaultSystemPrompt
  const systemPrompt = asSystemPrompt(appendSystemPrompt ? [...promptParts, appendSystemPrompt] : promptParts)

  // The SDK can fire a side question mid-turn: an in-progress assistant
  // message (stop reason still null) is dropped from the fork context.
  let forkContextMessages = messages
  const last = messages[messages.length - 1]
  if (last && last.type === 'assistant' && (last as AssistantMessage).message.stop_reason === null) {
    forkContextMessages = messages.slice(0, -1)
  }

  const resolvedThinking: ThinkingConfig =
    thinkingConfig ?? (shouldEnableThinkingByDefault() ? { type: 'adaptive' } : { type: 'disabled' })

  const toolUseContext: ToolUseContext = {
    options: {
      commands,
      debug: false,
      verbose: false,
      mainLoopModel,
      tools,
      thinkingConfig: resolvedThinking,
      mcpClients,
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: agents, allAgents: [] },
      customSystemPrompt,
      appendSystemPrompt,
    },
    abortController: createAbortController(),
    readFileState,
    getAppState,
    setAppState,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: forkContextMessages,
  }

  return { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages }
}
