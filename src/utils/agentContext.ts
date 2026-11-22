import type { AgentContext, InvocationKind, SubagentContext } from './run/ownerContext.js'
import { notBuilt } from '../pi/holes.js'

export type { SubagentContext, AgentContext }

export function getAgentContext(): AgentContext | undefined {
  return notBuilt('src/utils/agentContext.ts:11')
}

export function runWithAgentContext<T>(context: AgentContext, fn: () => T): T {
  return notBuilt('src/utils/agentContext.ts:15')
}


export function consumeInvokingRequestId():
  | { invokingRequestId: string; invocationKind?: InvocationKind }
  | undefined {
  return notBuilt('src/utils/agentContext.ts:20')
}
