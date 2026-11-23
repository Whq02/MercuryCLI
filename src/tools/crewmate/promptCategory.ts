import type { QuerySource } from '../../engine/requests/querySource.js'


export function getQuerySourceForAgent(agentType: string | undefined, isBuiltInAgent: boolean): QuerySource {
  if (isBuiltInAgent) return agentType ? `agent:builtin:${agentType}` : 'agent:default'
  return 'agent:custom'
}
