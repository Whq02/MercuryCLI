
import {
  CRITTER_COUNT,
  critterAt,
  type CritterDef,
} from './critterData.js'

export function critterKeyFor(agentId: string, sessionId: string | null | undefined): string {
  return agentId === 'main' ? sessionId || 'main' : agentId
}

const assigned = new Map<string, number>()
let nextVariant = 0

export function critterVariantFor(key: string | null | undefined): number {
  if (!key) return 0
  let v = assigned.get(key)
  if (v === undefined) {
    v = nextVariant % CRITTER_COUNT
    assigned.set(key, v)
    nextVariant += 1
    if (assigned.size > 256) {
      const oldest = assigned.keys().next().value
      if (oldest !== undefined) assigned.delete(oldest)
    }
  }
  return v
}

export function critterForKey(key: string | null | undefined): CritterDef {
  return critterAt(critterVariantFor(key))
}
