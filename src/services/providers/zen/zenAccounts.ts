import { readStoredZenApiKey } from '../../../utils/router/providerSecrets.js'

export const ZEN_API_BASE_URL = 'https://opencode.ai/zen/v1'
export const ZEN_GO_API_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const ZEN_CONSOLE_URL = 'https://opencode.ai/auth'
export const ZEN_ENV_KEY = 'OPENCODE_API_KEY'

export function zenApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MERCURY_ZEN_API_BASE?.trim() || ZEN_API_BASE_URL).replace(/\/+$/, '')
}

export function zenGoApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MERCURY_ZEN_GO_API_BASE?.trim() || ZEN_GO_API_BASE_URL).replace(/\/+$/, '')
}

export function zenChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${zenApiBase(env)}/chat/completions`
}

export function zenResponsesUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${zenApiBase(env)}/responses`
}

export function zenModelsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${zenApiBase(env)}/models`
}

export function zenGoUsageUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${zenGoApiBase(env)}/usage`
}

export function resolveZenApiKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'stored' } | undefined {
  const key = env[ZEN_ENV_KEY]?.trim()
  if (key) return { key, source: 'env' }
  const stored = readStoredZenApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface ZenAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveZenAccount(env: NodeJS.ProcessEnv = process.env): ZenAccountRef | undefined {
  const key = resolveZenApiKey(env)
  return key
    ? { kind: 'api-key', label: key.source === 'env' ? `${ZEN_ENV_KEY} (env)` : 'OpenCode Zen API key (stored, auth-scoped)', keySource: key.source }
    : undefined
}

export function zenRequestHeaders(userAgent: string, sessionId: string): Record<string, string> {
  return { 'user-agent': userAgent, 'x-opencode-session': sessionId }
}
