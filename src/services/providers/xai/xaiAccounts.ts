import { readStoredXaiApiKey, readStoredXaiManagementApiKey } from '../../../utils/router/providerSecrets.js'
import { readPreferredXaiSource, refreshXaiTokens, xaiStoredTokens, type XaiOauthIo } from './xaiOauth.js'

const XAI_API_BASE_URL = 'https://api.x.ai/v1'

export function xaiApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_XAI_API_BASE']?.trim() || XAI_API_BASE_URL).replace(/\/+$/, '')
}

export function xaiChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${xaiApiBase(env)}/chat/completions`
}

export function xaiManagementBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_XAI_MANAGEMENT_API_BASE']?.trim() || 'https://management-api.x.ai').replace(/\/+$/, '')
}

export function resolveXaiManagementApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const key = env.XAI_MANAGEMENT_API_KEY?.trim()
  if (key) return { key, source: 'env' }
  const stored = readStoredXaiManagementApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export function resolveXaiApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const key = env.XAI_API_KEY?.trim()
  if (key) return { key, source: 'env' }
  const stored = readStoredXaiApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface XaiAccountRef {
  kind: 'api-key' | 'grok-subscription'
  label: string
  keySource?: 'env' | 'stored'
  email?: string
}

export function resolveXaiCredentialSnapshot(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'stored' | 'oauth' } | undefined {
  if (resolveXaiAccount(env)?.kind === 'grok-subscription') {
    const tokens = xaiStoredTokens()
    return tokens?.refreshToken ? { key: tokens.accessToken, source: 'oauth' } : undefined
  }
  return resolveXaiApiKey(env)
}
export async function resolveXaiCredential(io?: XaiOauthIo): Promise<{ key: string; source: 'env' | 'stored' | 'oauth' } | undefined> {
  if (resolveXaiAccount(io?.env)?.kind === 'grok-subscription') {
    const tokens = await refreshXaiTokens(io)
    return tokens?.refreshToken ? { key: tokens.accessToken, source: 'oauth' } : undefined
  }
  return resolveXaiApiKey(io?.env)
}
export function resolveXaiAccount(env: NodeJS.ProcessEnv = process.env): XaiAccountRef | undefined {
  const key = resolveXaiApiKey(env)
  const tokens = xaiStoredTokens()
  if (tokens && !(readPreferredXaiSource() === 'api-key' && key)) return { kind: 'grok-subscription', label: 'Grok subscription', ...(tokens.email ? { email: tokens.email } : {}) }
  return key ? {
    kind: 'api-key',
    label: key.source === 'env' ? 'XAI_API_KEY (env)' : 'xAI API key (stored, auth-scoped)',
    keySource: key.source,
  } : undefined
}
