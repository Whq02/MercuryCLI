import { readStoredDeepseekApiKey } from '../../../utils/router/providerSecrets.js'

const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com'

export function deepseekApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_DEEPSEEK_API_BASE']?.trim() || DEEPSEEK_API_BASE_URL
}
export function deepseekChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${deepseekApiBase(env)}/chat/completions`
}
export function deepseekBalanceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${deepseekApiBase(env)}/user/balance`
}

export function resolveDeepseekApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env.DEEPSEEK_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredDeepseekApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface DeepseekAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveDeepseekAccount(
  env: NodeJS.ProcessEnv = process.env,
): DeepseekAccountRef | undefined {
  const key = resolveDeepseekApiKey(env)
  if (!key) return undefined
  return {
    kind: 'api-key',
    label: key.source === 'env' ? 'DEEPSEEK_API_KEY (env)' : 'DeepSeek API key (stored, auth-scoped)',
    keySource: key.source,
  }
}
