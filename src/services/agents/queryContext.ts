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
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type PromptInputs = {
  tools: Tools; engineModel: string; mcpClients: MCPServerConnection[]
  customSystemPrompt?: string; permissionMode?: InternalPermissionMode
  memoryTask?: import('../../mneme/entryKnapsack.js').StartTask
}
type PromptParts = {
  defaultSystemPrompt: string[]; userContext: Record<string, string>; systemContext: Record<string, string>
}
type ForkInputs = Unbuilt

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

export async function buildSideQuestionFallbackParams(input: ForkInputs): Promise<CacheSafeParams> {
  return notBuilt('src/services/agents/queryContext.ts:67')
}
