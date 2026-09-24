import { readStoredTypesafeApiKey, writeStoredTypesafeApiKey } from '../../utils/router/providerSecrets.js'
import { noteJevKeyChanged } from './jevLedger.js'

export const JEV_KEY_ENV = 'TYPESAFE_API_KEY'

export type JevKeySource = 'env' | 'stored'

export type JevKeyPresence = { present: true; source: JevKeySource } | { present: false }

export function resolveJevApiKey(env: Record<string, string | undefined> = process.env): { key: string; source: JevKeySource } | undefined {
  const pinned = env[JEV_KEY_ENV]?.trim()
  if (pinned) return { key: pinned, source: 'env' }
  const stored = readStoredTypesafeApiKey()
  if (stored) return { key: stored, source: 'stored' }
  return undefined
}

export function jevKeyPresence(env: Record<string, string | undefined> = process.env): JevKeyPresence {
  const resolved = resolveJevApiKey(env)
  return resolved ? { present: true, source: resolved.source } : { present: false }
}

export function storeJevApiKey(key: string | null): void {
  writeStoredTypesafeApiKey(key)
  noteJevKeyChanged()
}

export function jevKeySourceWords(presence: JevKeyPresence): string {
  if (!presence.present) return 'no key'
  return presence.source === 'env' ? `key present (${JEV_KEY_ENV} in the environment outranks the store)` : 'key stored (the credential store; the value is never shown)'
}
