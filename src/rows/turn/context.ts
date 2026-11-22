import { query } from '../../query.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import type { ConversationConfig } from '../turn.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

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

export function contextBuilder(arg0: ContextNeeds): Unbuilt {
  return notBuilt('src/rows/turn/context.ts:43')
}
