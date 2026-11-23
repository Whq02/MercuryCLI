import type { ToolUseContext } from '../../tools/kit/tool.js'
import { isBuiltInAgent, type AgentDefinition } from '../../crew/agents/agentDefinition.js'
import { MERCURY_CONSTITUTION } from './mercuryContract.js'
import { isWholeRecordedComposition } from './recordedComposition.js'
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

  if (isWholeRecordedComposition(defaultSystemPrompt)) {
    return asSystemPrompt([...defaultSystemPrompt])
  }

  const agentPrompt = mainThreadAgentDefinition
    ? isBuiltInAgent(mainThreadAgentDefinition)
      ? mainThreadAgentDefinition.getSystemPrompt({ toolUseContext })
      : mainThreadAgentDefinition.getSystemPrompt()
    : undefined

  const base = agentPrompt
    ? [MERCURY_CONSTITUTION, agentPrompt]
    : customSystemPrompt !== undefined
      ? [MERCURY_CONSTITUTION, customSystemPrompt]
      : [...defaultSystemPrompt]

  if (appendSystemPrompt) {
    base.push(appendSystemPrompt)
  }

  return asSystemPrompt(base)
}
