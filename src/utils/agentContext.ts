import { AsyncLocalStorage } from 'node:async_hooks'

import { isCrewEnabled } from './crewEnabled.js'


type InvocationEdge = {
  invokingRequestId?: string
  invocationKind?: 'spawn' | 'resume'
  invocationEmitted?: boolean
}

export type SubagentContext = InvocationEdge & {
  agentType: 'subagent'
  agentId: string
  parentSessionId?: string
  subagentName?: string
  isBuiltIn?: boolean
}

export type CrewmateAgentContext = InvocationEdge & {
  agentType: 'crewmate'
  agentId: string
  agentName: string
  crewName: string
  agentColor?: string
  parentSessionId: string
  isCrewLead: boolean
}

export type AgentContext = SubagentContext | CrewmateAgentContext

const storage = new AsyncLocalStorage<AgentContext>()

export function getAgentContext(): AgentContext | undefined {
  return storage.getStore()
}

export function runWithAgentContext<T>(context: AgentContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function isSubagentContext(context: AgentContext | undefined): context is SubagentContext {
  return context !== undefined && context.agentType === 'subagent'
}

export function isCrewmateAgentContext(context: AgentContext | undefined): context is CrewmateAgentContext {
  if (!isCrewEnabled()) return false
  return context !== undefined && context.agentType === 'crewmate'
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
