import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../types/agent.js'
import type { SystemPrompt } from './systemPromptType.js'
import { notBuilt } from '../pi/holes.js'


export function buildEffectiveSystemPrompt(arg0: {
  mainThreadAgentDefinition: AgentDefinition | undefined
  toolUseContext: Pick<ToolUseContext, 'options'>
  customSystemPrompt: string | undefined
  defaultSystemPrompt: string[]
  appendSystemPrompt: string | undefined
  overrideSystemPrompt?: string
}): SystemPrompt {
  return notBuilt('src/utils/systemPrompt.ts:11')
}
