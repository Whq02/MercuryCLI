import { AsyncLocalStorage } from 'node:async_hooks'

import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'

/**
 * Async-scoped agent identity for attribution. Backgrounded agents run
 * simultaneously in one process, and a single shared state slot would let
 * one agent's events be attributed to another — async-local storage
 * isolates each execution chain instead.
 */

/**
 * The per-invocation spawn/resume edge: the request id of the invoking
 * agent's API request, which invocation kind minted it, and whether the
 * edge has already been emitted to telemetry. For nested subagents the
 * invoking request id is the IMMEDIATE invoker, not the root — the session
 * id already bundles the whole tree. Updated on every resume.
 */
type InvocationEdge = {
  invokingRequestId?: string
  invocationKind?: 'spawn' | 'resume'
  invocationEmitted?: boolean
}

export type SubagentContext = InvocationEdge & {
  agentType: 'subagent'
  agentId: string
  /** Absent for subagents of the main session. */
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
  /** The lead's session id, for transcript correlation. */
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

/**
 * Gated: when agent teams are disabled this always answers false,
 * regardless of what the store holds.
 */
export function isTeammateAgentContext(context: AgentContext | undefined): context is TeammateAgentContext {
  if (!isAgentSwarmsEnabled()) return false
  return context !== undefined && context.agentType === 'teammate'
}

/**
 * A safe analytics name for the current subagent: built-in type names are
 * code constants and may be logged; user-defined names are never emitted —
 * the literal substitution is what makes the value loggable at all.
 */
export function getSubagentLogName(): string | undefined {
  const context = getAgentContext()
  if (!context || !isSubagentContext(context)) return undefined
  if (!context.subagentName) return undefined
  return context.isBuiltIn ? context.subagentName : 'user-defined'
}

/**
 * Consume the invoking request id exactly once per invocation: the first
 * call after a spawn or resume returns the edge, later calls return
 * undefined until the next boundary. Sparse edge semantics — the field
 * appears on exactly one terminal API telemetry event per invocation, so a
 * non-null value downstream unambiguously marks a spawn or resume boundary.
 */
export function consumeInvokingRequestId():
  | { invokingRequestId: string; invocationKind?: 'spawn' | 'resume' }
  | undefined {
  const context = getAgentContext()
  if (!context) return undefined
  if (context.invocationEmitted) return undefined
  // The edge is returned whenever an unemitted invoking request id exists —
  // a missing invocation kind never suppresses it.
  if (context.invokingRequestId === undefined) return undefined
  context.invocationEmitted = true
  return {
    invokingRequestId: context.invokingRequestId,
    ...(context.invocationKind !== undefined ? { invocationKind: context.invocationKind } : {}),
  }
}
