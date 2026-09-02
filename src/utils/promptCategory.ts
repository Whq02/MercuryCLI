import type { QuerySource } from '../constants/querySource.js'

/**
 * Analytics query-source labels for agent turns and REPL turns.
 */

export function getQuerySourceForAgent(agentType: string | undefined, isBuiltInAgent: boolean): QuerySource {
  if (isBuiltInAgent) return agentType ? `agent:builtin:${agentType}` : 'agent:default'
  return 'agent:custom'
}

export function getQuerySourceForREPL(): QuerySource {
  return 'repl_main_thread'
}
