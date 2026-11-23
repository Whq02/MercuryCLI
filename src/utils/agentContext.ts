import {
  getOwnerContext,
  withOwnerContext,
  type AgentContext,
  type InvocationKind,
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
  | { invokingRequestId: string; invocationKind?: InvocationKind }
  | undefined {
  const context = getAgentContext()
  if (!context || context.invokingRequestId === undefined || context.invocationEmitted) {
    return undefined
  }
  context.invocationEmitted = true
  return context.invocationKind !== undefined
    ? { invokingRequestId: context.invokingRequestId, invocationKind: context.invocationKind }
    : { invokingRequestId: context.invokingRequestId }
}
