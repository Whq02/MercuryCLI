import type { QuerySource } from '../constants/querySource.js'


export function getQuerySourceForAgent(agentType: string | undefined, isBuiltInAgent: boolean): QuerySource {
  if (isBuiltInAgent) return agentType ? `agent:builtin:${agentType}` : 'agent:default'
  return 'agent:custom'
}

export function getQuerySourceForChat(): QuerySource {
  return 'main_thread'
}
