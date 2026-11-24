import {
  getOwnerContext,
  withOwnerContext,
  type InvocationKind,
  type CrewmateContext,
} from '../../engine/run-owner/ownerContext.js'

export type { CrewmateContext }

export function getCrewmateContext(): CrewmateContext | undefined {
  return getOwnerContext()?.agent
}

export function runWithCrewmateContext<T>(context: CrewmateContext, fn: () => T): T {
  return withOwnerContext({ agent: context }, fn)
}

export function consumeInvokingRequestId():
  | { invokingRequestId: string; invocationKind?: InvocationKind }
  | undefined {
  const context = getCrewmateContext()
  if (!context || context.invokingRequestId === undefined || context.invocationEmitted) {
    return undefined
  }
  context.invocationEmitted = true
  return context.invocationKind !== undefined
    ? { invokingRequestId: context.invokingRequestId, invocationKind: context.invocationKind }
    : { invokingRequestId: context.invokingRequestId }
}
