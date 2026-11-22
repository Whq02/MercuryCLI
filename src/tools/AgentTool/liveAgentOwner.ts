import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { notBuilt } from '../../pi/holes.js'

export function liveAgentOwner(
  agentId: string,
  tasks: Record<string, unknown> | undefined,
): { kind: 'agent'; words: string } | null {
  return notBuilt('src/tools/AgentTool/liveAgentOwner.ts:4')
}
