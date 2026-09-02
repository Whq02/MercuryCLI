import { randomBytes, type UUID } from 'node:crypto'

import type { AgentId } from '../types/ids.js'

/**
 * UUID shape validation and prefixed agent-id minting.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The value typed as a UUID when it matches the canonical 8-4-4-4-12 hex form; null otherwise (non-strings never throw). */
export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return UUID_PATTERN.test(maybeUuid) ? (maybeUuid as UUID) : null
}

/**
 * `a<16 hex>`, or `a<label>-<16 hex>` with a label. The `a` prefix keeps
 * agent ids distinguishable from task ids at a glance; the label is
 * inserted verbatim (callers supply safe labels). Randomness is
 * cryptographic — 8 random bytes, hex-encoded.
 */
export function createAgentId(label?: string): AgentId {
  const suffix = randomBytes(8).toString('hex')
  const id = label !== undefined ? `a${label}-${suffix}` : `a${suffix}`
  return id as AgentId
}
