import { AsyncLocalStorage } from 'node:async_hooks'
import type { OwnerKey } from './ownerKey.js'

export type InvocationKind = 'spawn' | 'resume'

type InvocationEdge = {
  invokingRequestId?: string
  invocationKind?: InvocationKind
  invocationEmitted?: boolean
}

export type SubagentContext = InvocationEdge & {
  agentType: 'subagent'
  agentId: string
  subagentName?: string
  isBuiltIn?: boolean
}

export type AgentContext = SubagentContext

export interface LeaseHolder {
  sessionId: string
  agentId: string
  pid: number
  procStart?: string
}

type OwnerDirectoryContext = {
  cwd: string | undefined
  shellCwd: string | null
}

type OwnerContext = {
  agent?: AgentContext
  directory?: OwnerDirectoryContext
  workload?: string | undefined
  authHome?: string
  fetchSession?: OwnerKey
  leaseHolder?: LeaseHolder
}

const ownerContextStorage = new AsyncLocalStorage<OwnerContext>()

export function getOwnerContext(): OwnerContext | undefined {
  return ownerContextStorage.getStore()
}

export function withOwnerContext<T>(patch: OwnerContext, work: () => T): T {
  return ownerContextStorage.run({ ...ownerContextStorage.getStore(), ...patch }, work)
}
