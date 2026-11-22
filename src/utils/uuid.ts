import type { UUID } from 'node:crypto'

import type { AgentId } from '../types/ids.js'
import { notBuilt } from '../pi/holes.js'

export function validateUuid(maybeUuid: unknown): UUID | null {
  return notBuilt('src/utils/uuid.ts:8')
}

export function createAgentId(label?: string): AgentId {
  return notBuilt('src/utils/uuid.ts:13')
}
