import { readStoredNousApiKey } from '../../../utils/router/providerSecrets.js'
import { credentialFingerprint } from '../credentialIdentity.js'

const NOUS_API_BASE_URL = 'https://inference-api.nousresearch.com/v1'
const NOUS_PORTAL_BASE_URL = 'https://portal.nousresearch.com'

export const NOUS_API_KEY_ENV = 'NOUS_API_KEY'

export function nousApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_NOUS_API_BASE']?.trim() || NOUS_API_BASE_URL).replace(/\/+$/, '')
}

export function nousChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${nousApiBase(env)}/chat/completions`
}

export function nousModelsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${nousApiBase(env)}/models`
}

export function nousPortalBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_NOUS_PORTAL_BASE']?.trim() || NOUS_PORTAL_BASE_URL).replace(/\/+$/, '')
}

export function nousAccountUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${nousPortalBase(env)}/api/oauth/account`
}

export function resolveNousApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env[NOUS_API_KEY_ENV]?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredNousApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface NousAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveNousAccount(env: NodeJS.ProcessEnv = process.env): NousAccountRef | undefined {
  const key = resolveNousApiKey(env)
  if (!key) return undefined
  return {
    kind: 'api-key',
    label: key.source === 'env' ? `${NOUS_API_KEY_ENV} (env)` : 'Nous Portal API key (stored, auth-scoped)',
    keySource: key.source,
  }
}

export function nousAccountIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return credentialFingerprint(resolveNousApiKey(env)?.key)
}
