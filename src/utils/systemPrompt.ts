import { MERCURY_IDENTITY_FLOOR } from '../prompt/mercuryContract.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'
import type { SystemPrompt } from './systemPromptType.js'
import { asSystemPrompt } from './systemPromptType.js'

/**
 * Chooses which system prompt applies and guarantees the identity floor.
 */

export { asSystemPrompt } from './systemPromptType.js'
export type { SystemPrompt } from './systemPromptType.js'

/**
 * Precedence, highest first: a non-empty override alone (the SDK's exact
 * replacement contract — nothing prepended or appended); an agent
 * definition's non-empty prompt; a custom prompt; the default array.
 *
 * The identity floor: an agent or custom prompt REPLACES the default,
 * which is where the always-on identity and honesty floor normally lives —
 * so the minimal floor is prepended ahead of the replacing prompt as its
 * own element. The floor is inviolable by design; a custom or agent prompt
 * must not be able to bypass it. The default path already carries it, and
 * the override path is deliberately untouched.
 */
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
