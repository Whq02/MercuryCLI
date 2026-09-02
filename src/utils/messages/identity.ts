
import { createHash } from 'node:crypto'
import type { UUID } from 'crypto'

export function deriveUUID(parentUUID: UUID, index: number): UUID {
  const suffix = createHash('sha1').update(`${parentUUID}:${index}`).digest('hex').slice(0, 12)
  return `${parentUUID.slice(0, 24)}${suffix}` as UUID
}

export function deriveShortMessageId(uuid: string): string {
  const leadingHex = uuid.replace(/-/g, '').slice(0, 10)
  return parseInt(leadingHex, 16).toString(36).slice(0, 6)
}
