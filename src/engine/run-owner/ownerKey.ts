
const KEY_PREFIX = 'mo1'

export interface OwnerIdentity {
  workspace: string
  sessionId: string
  lane: string
  querySource?: string
}

export type OwnerKey = string & { readonly __ownerKey: unique symbol }

const enc = (s: string): string => encodeURIComponent(s)
const dec = (s: string): string => decodeURIComponent(s)

export function makeOwnerKey(id: OwnerIdentity): OwnerKey {
  return [
    KEY_PREFIX,
    enc(id.workspace),
    enc(id.sessionId),
    enc(id.lane),
    enc(id.querySource ?? ''),
  ].join('|') as OwnerKey
}

export function isOwnerKey(value: unknown): value is OwnerKey {
  if (typeof value !== 'string') return false
  const parts = value.split('|')
  return parts.length === 5 && parts[0] === KEY_PREFIX
}

export function ownerEquals(a: OwnerKey, b: OwnerKey): boolean {
  return a === b
}

export function parseOwnerKey(key: OwnerKey): OwnerIdentity {
  const parts = key.split('|')
  if (parts.length !== 5 || parts[0] !== KEY_PREFIX) {
    throw new Error(`not a canonical owner key: ${key.slice(0, 40)}`)
  }
  return {
    workspace: dec(parts[1]!),
    sessionId: dec(parts[2]!),
    lane: dec(parts[3]!),
    querySource: parts[4] ? dec(parts[4]!) : undefined,
  }
}

export const MAIN_LANE = 'main'

export function agentLane(agentId: string): string {
  return `agent:${agentId}`
}

export function ownerKeyFileStem(key: OwnerKey): string {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0
  const id = parseOwnerKey(key)
  const lane = id.lane.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)
  return `${id.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 36)}-${lane}-${(h >>> 0).toString(36)}`
}
