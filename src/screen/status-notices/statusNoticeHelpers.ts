import { roughTokenCountEstimation } from '../../models/facts/tokenEstimation.js'
import type { AgentDefinitionsResult } from '../../crew/agents/agentDefinition.js'
import { isBuiltInAgent } from '../../crew/agents/agentDefinition.js'


export const AGENT_DESCRIPTIONS_THRESHOLD = 15_000

export function getAgentDescriptionsTotalTokens(agentDefinitions?: AgentDefinitionsResult): number {
  if (!agentDefinitions) return 0
  let total = 0
  for (const agent of agentDefinitions.activeAgents) {
    if (isBuiltInAgent(agent)) continue
    total += roughTokenCountEstimation(`${agent.agentType}: ${agent.whenToUse}`)
  }
  return total
}
