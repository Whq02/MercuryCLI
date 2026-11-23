import { createHash, type UUID } from 'crypto'

export function deriveUUID(parentUUID: UUID, index: number): UUID {
  const digest = createHash('sha1').update(`${parentUUID}:${index}`, 'utf8').digest('hex')
  return `${parentUUID.slice(0, 24)}${digest.slice(0, 12)}` as UUID
}

export function deriveShortMessageId(uuid: string): string {
  return parseInt(uuid.replaceAll('-', '').slice(0, 10), 16).toString(36).slice(0, 6)
}
