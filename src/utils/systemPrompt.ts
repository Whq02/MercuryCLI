import type { ToolUseContext } from '../Tool.js'
import { isBuiltInAgent, type AgentDefinition } from '../types/agent.js'
import { MERCURY_CONSTITUTION } from '../prompt/mercuryContract.js'
import { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'


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
  if (overrideSystemPrompt) {
    return asSystemPrompt([overrideSystemPrompt])
  }

  let base: string[]
  if (mainThreadAgentDefinition) {
    const agentPrompt = isBuiltInAgent(mainThreadAgentDefinition)
      ? mainThreadAgentDefinition.getSystemPrompt({ toolUseContext })
      : mainThreadAgentDefinition.getSystemPrompt()
    base = agentPrompt ? [MERCURY_CONSTITUTION, agentPrompt] : [MERCURY_CONSTITUTION]
  } else if (customSystemPrompt) {
    base = [MERCURY_CONSTITUTION, customSystemPrompt]
  } else {
    base = [...defaultSystemPrompt]
  }

  if (appendSystemPrompt) {
    base.push(appendSystemPrompt)
  }

  return asSystemPrompt(base)
}
