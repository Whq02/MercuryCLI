import { DEFAULT_AGENT_PROMPT } from '../../../constants/prompts.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import { MERCURY_CREW_AGENT_TYPE } from '../constants.js'

export const MERCURY_CREW_AGENT: BuiltInAgentDefinition = {
  agentType: MERCURY_CREW_AGENT_TYPE,
  whenToUse:
    "Mercury's crew agent, the default for delegated work of every kind: open-ended research and keyword or file hunts, multi-step changes, running and checking commands, and carrying a brief — a design, a review, a verification — to its end with the session's full tool set. Hand it the objective, the context it arrives without, and whether it may write.",
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => DEFAULT_AGENT_PROMPT,
}
