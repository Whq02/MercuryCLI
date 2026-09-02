import { MERCURY_IDENTITY_FLOOR } from '../prompt/mercuryContract.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'
import type { SystemPrompt } from './systemPromptType.js'
import { asSystemPrompt } from './systemPromptType.js'


export { asSystemPrompt } from './systemPromptType.js'
export type { SystemPrompt } from './systemPromptType.js'

export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  toolUseContext,
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt,
  overrideSystemPrompt,
}: {
  mainThreadAgentDefinition: AgentDefinition | undefined
  toolUseContext: Pick<ToolUseContext, 'options'>
  customSystemPrompt: string | undefined
  defaultSystemPrompt: string[]
  appendSystemPrompt: string | undefined
  overrideSystemPrompt?: string
}): SystemPrompt {
  if (overrideSystemPrompt !== undefined && overrideSystemPrompt !== '') {
    return asSystemPrompt([overrideSystemPrompt])
  }

  const agentPrompt = mainThreadAgentDefinition
    ? isBuiltInAgent(mainThreadAgentDefinition)
      ? mainThreadAgentDefinition.getSystemPrompt({ toolUseContext })
      : mainThreadAgentDefinition.getSystemPrompt()
    : undefined

  const parts: string[] = []
  if (agentPrompt !== undefined && agentPrompt !== '') {
    parts.push(MERCURY_IDENTITY_FLOOR, agentPrompt)
  } else if (customSystemPrompt !== undefined) {
    parts.push(MERCURY_IDENTITY_FLOOR, customSystemPrompt)
  } else {
    parts.push(...defaultSystemPrompt)
  }
  if (appendSystemPrompt !== undefined && appendSystemPrompt !== '') {
    parts.push(appendSystemPrompt)
  }
  return asSystemPrompt(parts)
}
