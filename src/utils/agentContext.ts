import { AsyncLocalStorage } from 'node:async_hooks'

import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'


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

export type TeammateAgentContext = InvocationEdge & {
  agentType: 'teammate'
  agentId: string
  agentName: string
  teamName: string
  agentColor?: string
  planModeRequired: boolean
  parentSessionId: string
  isTeamLead: boolean
}

export type AgentContext = SubagentContext | TeammateAgentContext

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

export function isTeammateAgentContext(context: AgentContext | undefined): context is TeammateAgentContext {
  if (!isAgentSwarmsEnabled()) return false
  return context !== undefined && context.agentType === 'teammate'
}

export function getSubagentLogName(): string | undefined {
  const context = getAgentContext()
  if (!context || !isSubagentContext(context)) return undefined
  if (!context.subagentName) return undefined
  return context.isBuiltIn ? context.subagentName : 'user-defined'
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
