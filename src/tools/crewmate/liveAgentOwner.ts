import { isCrewmateTask } from '../../engine/tasks/local-agent/crewmateTask.js'
import { isMainSessionTask } from '../../engine/tasks/mainSessionTask.js'

export function liveCrewmateOwner(
  agentId: string,
  tasks: Record<string, unknown> | undefined,
): { kind: 'agent'; words: string } | null {
  const own = tasks?.[agentId]
  if (isCrewmateTask(own) && !isMainSessionTask(own) && own.status === 'running') {
    return {
      kind: 'agent',
      words:
        `Crewmate ${agentId} is running in this session — guidance for a running crewmate is queued by SendMessage ` +
        `and delivered at its next tool round; a second run is never started beside it.`,
    }
  }
  return null
}
