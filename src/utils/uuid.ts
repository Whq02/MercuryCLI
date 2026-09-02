import { randomBytes, type UUID } from 'node:crypto'

import type { AgentId } from '../types/ids.js'


const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return UUID_PATTERN.test(maybeUuid) ? (maybeUuid as UUID) : null
}

export function createAgentId(label?: string): AgentId {
  const suffix = randomBytes(8).toString('hex')
  const id = label !== undefined ? `a${label}-${suffix}` : `a${suffix}`
  return id as AgentId
}
