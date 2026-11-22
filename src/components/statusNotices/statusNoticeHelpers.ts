import { roughTokenCountEstimation } from '../../services/tokenEstimation.js'
import type { AgentDefinitionsResult } from '../../types/agent.js'
import { isBuiltInAgent } from '../../types/agent.js'
import { notBuilt } from '../../pi/holes.js'


export const AGENT_DESCRIPTIONS_THRESHOLD = 15_000

export function getAgentDescriptionsTotalTokens(agentDefinitions?: AgentDefinitionsResult): number {
  return notBuilt('src/components/statusNotices/statusNoticeHelpers.ts:8')
}
