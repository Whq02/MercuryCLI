import type { BuiltInAgentDefinition } from '../../../crew/agents/agentDefinition.js'
import { MERCURY_CREW_AGENT_TYPE } from '../../kit/names/agent.js'

export const MERCURY_CREW_AGENT: BuiltInAgentDefinition = {
  agentType: MERCURY_CREW_AGENT_TYPE,
  whenToUse:
    "Mercury's crew agent, the default for delegated work: open-ended research, multi-step changes, running commands, and carrying a design, review or verification brief to completion with the session's full tool set. Pass the objective, needed context, and whether it may write.",
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',
}
