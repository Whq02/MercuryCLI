import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'

export function liveAgentOwner(
  agentId: string,
  tasks: Record<string, unknown> | undefined,
): { kind: 'agent'; words: string } | null {
  const own = tasks?.[agentId]
  if (isLocalAgentTask(own) && !isMainSessionTask(own) && own.status === 'running') {
    return {
      kind: 'agent',
      words:
        `Crewmate ${agentId} is running in this session — guidance for a running crewmate is queued by SendMessage ` +
        `and delivered at its next tool round; a second run is never started beside it.`,
    }
  }
  return null
}
