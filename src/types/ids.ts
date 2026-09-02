// ============================================================================
//  src/types/ids.ts — branded session/agent identifiers.
//
//  Two branded string types that cannot be interchanged at compile time.
//  Prefer the minting functions; the raw casts exist for the rare boundary
//  where a string is already known-good. `toAgentId` VALIDATES — it accepts
//  exactly the format the agent-id minter produces and rejects teammate
//  names and team addresses, which are not agent ids.
// ============================================================================

import type { UUID } from 'crypto'

declare const sessionIdBrand: unique symbol
declare const agentIdBrand: unique symbol

/** A session identifier (a UUID underneath). Not assignable to/from
 *  AgentId; assignable WHERE a plain UUID is expected. */
export type SessionId = UUID & { readonly [sessionIdBrand]: true }

/** An agent identifier. Not assignable to/from SessionId. */
export type AgentId = string & { readonly [agentIdBrand]: true }

/** Unchecked brand cast. Use sparingly — prefer the minting functions. */
export function asSessionId(value: string): SessionId {
  return value as SessionId
}

/** Unchecked brand cast. Use sparingly — prefer the minting functions. */
export function asAgentId(value: string): AgentId {
  return value as AgentId
}

// The minter's format (contract data): the letter `a`, an optional non-empty
// label followed by a hyphen, then 16 lowercase hexadecimal characters,
// anchored at both ends.
const AGENT_ID_RE = /^a(?:.+-)?[0-9a-f]{16}$/

/**
 * Validating parse: an AgentId, or null (callers null-check) when the string
 * is not a minted agent id — e.g. a teammate name or a team address.
 */
export function toAgentId(value: string): AgentId | null {
  return AGENT_ID_RE.test(value) ? (value as AgentId) : null
}
