import { randomBytes, type UUID } from 'node:crypto'

import { asAgentId, type AgentId } from '../../sessions/transcripts/ids.js'

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return UUID_REGEX.test(maybeUuid) ? (maybeUuid as UUID) : null
}

export function createAgentId(label?: string): AgentId {
  const hex = randomBytes(8).toString('hex')
  return asAgentId(label !== undefined ? `a${label}-${hex}` : `a${hex}`)
}
