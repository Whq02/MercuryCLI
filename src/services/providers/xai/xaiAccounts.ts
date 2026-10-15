import { readStoredXaiApiKey, readStoredXaiManagementApiKey } from '../../../utils/router/providerSecrets.js'
import { readPreferredXaiSource, refreshXaiTokens, xaiStoredTokens, type XaiOauthIo } from './xaiOauth.js'

const XAI_API_BASE_URL = 'https://api.x.ai/v1'
const XAI_GROK_PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
export const XAI_GROK_PROXY_CLIENT_VERSION = '1.0.4'
export const XAI_GROK_PROXY_CHAT_CLIENT_VERSION = '2026.9.7'
export type XaiCredentialSource = 'env' | 'stored' | 'oauth'

export function xaiApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_XAI_API_BASE']?.trim() || XAI_API_BASE_URL).replace(/\/+$/, '')
}

export function xaiGrokProxyBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_XAI_GROK_PROXY_BASE']?.trim() || XAI_GROK_PROXY_BASE_URL).replace(/\/+$/, '')
}

export function xaiInferenceBase(source: XaiCredentialSource, env: NodeJS.ProcessEnv = process.env): string {
  return source === 'oauth' ? xaiGrokProxyBase(env) : xaiApiBase(env)
}

export function xaiChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env, source: XaiCredentialSource = 'stored'): string {
  return `${xaiInferenceBase(source, env)}/chat/completions`
}

export function xaiGrokProxyChatHeaders(model: string): Record<string, string> {
  return { 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-grok-client-version': XAI_GROK_PROXY_CHAT_CLIENT_VERSION, 'x-grok-model-override': model }
}

export function xaiGrokProxyBillingHeaders(): Record<string, string> {
  return { 'x-grok-client-mode': 'cli', 'x-grok-client-version': XAI_GROK_PROXY_CLIENT_VERSION }
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
