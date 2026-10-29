import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'


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
