import { createHash } from 'node:crypto'

export function credentialFingerprint(material: string | undefined | null): string {
  if (material === undefined || material === null || material === '') return 'none'
  return createHash('sha256').update(material).digest('hex').slice(0, 12)
}
