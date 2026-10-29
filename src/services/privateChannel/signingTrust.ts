
export interface TrustedSigningKey {
  keyId: string
  publicKeySpkiB64: string
  label: string
}

export const PRODUCTION_SIGNING_KEY: TrustedSigningKey | null = {
  keyId: '627b54b734ca0e72',
  publicKeySpkiB64: 'MCowBQYDK2VwAyEAR6cQX+5bl8NvZb4zwAfj45nAfuCjuwBAHWvN2a8RM7s=',
  label: 'Mercury release key (2026-08)',
}

export function trustedSigningKeys(): TrustedSigningKey[] {
  return PRODUCTION_SIGNING_KEY ? [PRODUCTION_SIGNING_KEY] : []
}
