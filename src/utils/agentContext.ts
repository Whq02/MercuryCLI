import {
  getOwnerContext,
  withOwnerContext,
  type AgentContext,
  type SubagentContext,
} from './run/ownerContext.js'

export type { SubagentContext, AgentContext }

export function getAgentContext(): AgentContext | undefined {
  return getOwnerContext()?.agent
}

export function runWithAgentContext<T>(context: AgentContext, fn: () => T): T {
  return withOwnerContext({ agent: context }, fn)
}


export function consumeInvokingRequestId():
  | { invokingRequestId: string; invocationKind?: 'spawn' | 'resume' }
  | undefined {
  const context = getAgentContext()
  if (!context) return undefined
  if (context.invocationEmitted) return undefined
  if (context.invokingRequestId === undefined) return undefined
  context.invocationEmitted = true
  return {
    invokingRequestId: context.invokingRequestId,
    ...(context.invocationKind !== undefined ? { invocationKind: context.invocationKind } : {}),
  }
}
