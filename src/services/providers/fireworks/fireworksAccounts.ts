import { readStoredFireworksApiKey } from '../providerSecrets.js'

const FIREWORKS_API_BASE_URL = 'https://api.fireworks.ai/inference/v1'
const FIREWORKS_ENV_KEY = 'FIREWORKS_API_KEY'

export function fireworksApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MERCURY_FIREWORKS_API_BASE?.trim() || FIREWORKS_API_BASE_URL).replace(/\/+$/, '')
}

export function fireworksChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${fireworksApiBase(env)}/chat/completions`
}

export function fireworksEnvKey(env: NodeJS.ProcessEnv = process.env): { key: string; name: 'FIREWORKS_API_KEY' } | undefined {
  const key = env[FIREWORKS_ENV_KEY]?.trim()
  return key ? { key, name: FIREWORKS_ENV_KEY } : undefined
}

export function resolveFireworksApiKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'stored' } | undefined {
  const key = fireworksEnvKey(env)
  if (key) return { key: key.key, source: 'env' }
  const stored = readStoredFireworksApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

interface FireworksAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveFireworksAccount(env: NodeJS.ProcessEnv = process.env): FireworksAccountRef | undefined {
  const key = resolveFireworksApiKey(env)
  return key ? { kind: 'api-key', label: key.source === 'env' ? `${FIREWORKS_ENV_KEY} (env)` : 'Fireworks API key (stored, auth-scoped)', keySource: key.source } : undefined
}
