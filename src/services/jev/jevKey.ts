import { createHash } from 'node:crypto'
import { readStoredTypesafeApiKey, writeStoredTypesafeApiKey } from '../../utils/router/providerSecrets.js'
import { resolveOpenrouterApiKey } from '../providers/openrouter/openrouterAccounts.js'
import type { JevRoad } from './jevContract.js'
import { noteJevKeyChanged } from './jevLedger.js'
import { readJevSettings } from './jevSetting.js'

export const JEV_KEY_ENV = 'TYPESAFE_API_KEY'
export type JevKeySource = 'env' | 'stored' | 'oauth'
export type JevKeyPresence = { present: true; source: JevKeySource } | { present: false }
const identities = new Map<JevRoad, string>()

export function resolveJevApiKey(env: Record<string, string | undefined> = process.env, road: JevRoad = readJevSettings().road): { key: string; source: JevKeySource } | undefined {
  const official = (): { key: string; source: JevKeySource } | undefined => {
    const pinned = env[JEV_KEY_ENV]?.trim()
    if (pinned) return { key: pinned, source: 'env' }
    const stored = readStoredTypesafeApiKey()
    return stored ? { key: stored, source: 'stored' } : undefined
  }
  const resolved = road === 'openrouter' ? resolveOpenrouterApiKey(env) : official()
  const identity = resolved ? createHash('sha256').update(resolved.key).digest('hex') : 'none'
  if (identities.has(road) && identities.get(road) !== identity) noteJevKeyChanged(road)
  identities.set(road, identity)
  return resolved
}

export function jevKeyPresence(env: Record<string, string | undefined> = process.env, road: JevRoad = readJevSettings().road): JevKeyPresence {
  const resolved = resolveJevApiKey(env, road)
  return resolved ? { present: true, source: resolved.source } : { present: false }
}

export function storeJevApiKey(key: string | null): void {
  writeStoredTypesafeApiKey(key)
  noteJevKeyChanged('official')
}

export function jevKeySourceWords(presence: JevKeyPresence, road: JevRoad = readJevSettings().road): string {
  if (!presence.present) return road === 'openrouter' ? 'no key — sign in or paste an OpenRouter key at /logins' : 'no key'
  if (road === 'openrouter') return presence.source === 'env' ? 'key present (OPENROUTER_API_KEY)' : presence.source === 'oauth' ? 'OpenRouter sign-in (/logins)' : 'OpenRouter key stored (/logins)'
  return presence.source === 'env' ? `key present (${JEV_KEY_ENV} in the environment outranks the store)` : 'key stored (the credential store; the value is never shown)'
}
