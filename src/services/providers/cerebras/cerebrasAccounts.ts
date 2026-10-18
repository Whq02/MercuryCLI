import { readStoredCerebrasApiKey } from '../providerSecrets.js'

const CEREBRAS_API_BASE_URL = 'https://api.cerebras.ai/v1'
const CEREBRAS_ENV_KEY = 'CEREBRAS_API_KEY'

export function cerebrasApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MERCURY_CEREBRAS_API_BASE?.trim() || CEREBRAS_API_BASE_URL).replace(/\/+$/, '')
}

export function cerebrasChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${cerebrasApiBase(env)}/chat/completions`
}

export function cerebrasEnvKey(env: NodeJS.ProcessEnv = process.env): { key: string; name: 'CEREBRAS_API_KEY' } | undefined {
  const key = env[CEREBRAS_ENV_KEY]?.trim()
  return key ? { key, name: CEREBRAS_ENV_KEY } : undefined
}

export function resolveCerebrasApiKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'stored' } | undefined {
  const key = cerebrasEnvKey(env)
  if (key) return { key: key.key, source: 'env' }
  const stored = readStoredCerebrasApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

interface CerebrasAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveCerebrasAccount(env: NodeJS.ProcessEnv = process.env): CerebrasAccountRef | undefined {
  const key = resolveCerebrasApiKey(env)
  return key ? { kind: 'api-key', label: key.source === 'env' ? `${CEREBRAS_ENV_KEY} (env)` : 'Cerebras API key (stored, auth-scoped)', keySource: key.source } : undefined
}
