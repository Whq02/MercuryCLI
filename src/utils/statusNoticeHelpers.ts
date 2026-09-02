import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'

/**
 * Token-estimate helper and threshold for the "agent descriptions are
 * large" status notice.
 */

/** Contract data: the published number in the notice message. */
export const AGENT_DESCRIPTIONS_THRESHOLD = 15_000

/**
 * Rough cumulative token estimate over the descriptions of the active,
 * non-built-in agents (agent type, a colon and a space, and the
 * when-to-use text). Zero with no agent-definitions result.
 */
export function getAgentDescriptionsTotalTokens(agentDefinitions?: AgentDefinitionsResult): number {
  if (!agentDefinitions) return 0
  let total = 0
  for (const agent of agentDefinitions.activeAgents) {
    if (isBuiltInAgent(agent)) continue
    total += roughTokenCountEstimation(`${agent.agentType}: ${agent.whenToUse}`)
  }
  return total
}
