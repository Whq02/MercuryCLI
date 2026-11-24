import { turnDoor } from '../../turnDoor.js'
import type { ToolUseContext } from '../../../tools/kit/tool.js'
import type { Message } from '../../message-shapes/message.js'
import { getGlobalConfig } from '../../../platform/settings/config.js'
import type { FileStateCache } from '../../../platform/files/fileStateCache.js'
import type { ThinkingConfig } from '../../../models/effort/thinking.js'
import type { ContentReplacementState } from '../../tool-dispatch/toolResultStorage.js'
import type { ConversationConfig } from '../turn.js'

function conversationOptions(config: ConversationConfig, model: string, thinkingConfig: ThinkingConfig): ToolUseContext['options'] {
  return {
    commands: config.commands,
    debug: false,
    verbose: false,
    engineModel: model,
    thinkingConfig,
    tools: config.tools,
    mcpClients: config.mcpClients,
    mcpResources: {},
    isNonInteractiveSession: true,
    ...(config.hostHoldsAsks === true ? { hostHoldsAsks: true } : {}),
    customSystemPrompt: config.customSystemPrompt,
    appendSystemPrompt: config.appendSystemPrompt,
    agentDefinitions: { activeAgents: config.agents ?? [], allAgents: [] },
    theme: getGlobalConfig().theme,
    maxBudgetUsd: config.maxBudgetUsd,
    runDeadline: config.maxTime,
    querySource: 'sdk',
  }
}

interface ContextNeeds {
  config: ConversationConfig
  thinkingConfig: ThinkingConfig
  turnId: string
  abortController: AbortController
  readFileState: FileStateCache
  contentReplacementState: ContentReplacementState
  discoveredSkillNames: Set<string>
  loadedNestedMemoryPaths: Set<string>
}

export function contextBuilder({ config, thinkingConfig, turnId, abortController, readFileState, contentReplacementState, discoveredSkillNames, loadedNestedMemoryPaths }: ContextNeeds) {
  const buildContext = (messages: Message[], model: string): ToolUseContext => ({
    options: conversationOptions(config, model, thinkingConfig),
    startTurn: turnDoor,
    abortController,
    readFileState,
    contentReplacementState,
    getAppState: config.getAppState,
    setAppState: config.setAppState,
    messages,
    setResponseLength: () => {},
    setInProgressToolUseIDs: () => {},
    callChain: { key: turnId, hop: 0 },
    updateFileHistoryState: updater => {
      config.setAppState(prev => {
        const next = updater(prev.fileHistory)
        return next === prev.fileHistory ? prev : { ...prev, fileHistory: next }
      })
    },
    handleElicitation: config.handleElicitation,
    setSDKStatus: config.setSDKStatus,
    takeModeNotice: config.takeModeNotice,
    discoveredSkillNames,
    loadedNestedMemoryPaths,
    nestedMemoryAttachmentTriggers: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
  })
  return buildContext
}
