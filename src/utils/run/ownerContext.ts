import { AsyncLocalStorage } from 'node:async_hooks'
import type { OwnerKey } from './ownerKey.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type InvocationKind = 'spawn' | 'resume'

export type SubagentContext = Unbuilt

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

type OwnerContext = Unbuilt

export function getOwnerContext(): OwnerContext | undefined {
  return notBuilt('src/utils/run/ownerContext.ts:44')
}

export function withOwnerContext<T>(patch: OwnerContext, work: () => T): T {
  return notBuilt('src/utils/run/ownerContext.ts:48')
}
