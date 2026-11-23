
import type { UUID } from 'crypto'

declare const sessionIdBrand: unique symbol
declare const agentIdBrand: unique symbol

export type SessionId = UUID & { readonly [sessionIdBrand]: true }

export type AgentId = string & { readonly [agentIdBrand]: true }

export function asSessionId(value: string): SessionId {
  return value as SessionId
}

export function asAgentId(value: string): AgentId {
  return value as AgentId
}

export const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
export const TASK_ID_SUFFIX_LENGTH = 8

const AGENT_ID_RE = new RegExp(`^a(?:[${TASK_ID_ALPHABET}]{${TASK_ID_SUFFIX_LENGTH}}|(?:.+-)?[0-9a-f]{16})$`)

export function toAgentId(value: string): AgentId | null {
  return AGENT_ID_RE.test(value) ? (value as AgentId) : null
}
