import { readStoredNousApiKey } from '../../../utils/router/providerSecrets.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { nousStoredTokens, nousSigninRefusal, readPreferredNousSource, refreshNousTokens, type NousOauthIo, type NousTokens } from './nousOauth.js'

const NOUS_API_BASE_URL = 'https://inference-api.nousresearch.com/v1'
const NOUS_PORTAL_BASE_URL = 'https://portal.nousresearch.com'

export const NOUS_API_KEY_ENV = 'NOUS_API_KEY'

export type NousCredentialSource = 'env' | 'stored' | 'signin'

export function nousApiBase(env: NodeJS.ProcessEnv = process.env, tokens?: NousTokens): string {
  return (env['MERCURY_NOUS_API_BASE']?.trim() || tokens?.inferenceBase || NOUS_API_BASE_URL).replace(/\/+$/, '')
}

export function nousChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env, source: NousCredentialSource = 'stored'): string {
  return `${nousApiBase(env, source === 'signin' ? nousStoredTokens() : undefined)}/chat/completions`
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
  kind: 'api-key' | 'signin'
  label: string
  keySource?: 'env' | 'stored'
  accountId?: string
  expired?: boolean
}

function signinWins(env: Record<string, string | undefined>): boolean {
  if (env[NOUS_API_KEY_ENV]?.trim()) return false
  const tokens = nousStoredTokens()
  if (tokens === undefined) return false
  return !(readPreferredNousSource() === 'api-key' && readStoredNousApiKey() !== undefined)
}

export function resolveNousAccount(env: NodeJS.ProcessEnv = process.env): NousAccountRef | undefined {
  if (signinWins(env)) {
    const tokens = nousStoredTokens()
    const expired = tokens === undefined || tokens.refreshToken.length === 0 || nousSigninRefusal() !== undefined
    return {
      kind: 'signin',
      label: 'Nous Portal sign-in',
      ...(tokens?.accountId !== undefined ? { accountId: tokens.accountId } : {}),
      ...(expired ? { expired: true } : {}),
    }
  }
  const key = resolveNousApiKey(env)
  if (!key) return undefined
  return {
    kind: 'api-key',
    label: key.source === 'env' ? `${NOUS_API_KEY_ENV} (env)` : 'Nous Portal API key (stored, auth-scoped)',
    keySource: key.source,
  }
}

export function resolveNousCredentialSnapshot(env: NodeJS.ProcessEnv = process.env): { key: string; source: NousCredentialSource } | undefined {
  if (signinWins(env)) {
    const tokens = nousStoredTokens()
    return tokens?.refreshToken && nousSigninRefusal() === undefined ? { key: tokens.accessToken, source: 'signin' } : undefined
  }
  return resolveNousApiKey(env)
}

export async function resolveNousCredential(io?: NousOauthIo): Promise<{ key: string; source: NousCredentialSource } | undefined> {
  const env = io?.env ?? process.env
  if (signinWins(env)) {
    if (nousSigninRefusal() !== undefined) return undefined
    const tokens = await refreshNousTokens(io)
    return tokens?.refreshToken ? { key: tokens.accessToken, source: 'signin' } : undefined
  }
  return resolveNousApiKey(env)
}

export function nousSigninIdentity(tokens: NousTokens | undefined): string {
  return tokens === undefined ? 'none' : `signin-${credentialFingerprint(tokens.accountId ?? tokens.accessToken)}`
}

export function nousAccountIdentity(env: NodeJS.ProcessEnv = process.env): string {
  if (signinWins(env)) return nousSigninIdentity(nousStoredTokens())
  return credentialFingerprint(resolveNousApiKey(env)?.key)
}
