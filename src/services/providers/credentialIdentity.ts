import { createHash } from 'node:crypto'

export function credentialFingerprint(material: string | undefined | null): string {
  if (material === undefined || material === null || material === '') return 'none'
  return createHash('sha256').update(material).digest('hex').slice(0, 12)
}

export function maskedKeyTail(key: string | undefined): string {
  const trimmed = key?.trim() ?? ''
  return trimmed.length >= 10 ? `…${trimmed.slice(-4)}` : ''
}
