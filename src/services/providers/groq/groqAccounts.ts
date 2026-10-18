import { readStoredGroqApiKey } from '../providerSecrets.js'

const GROQ_API_BASE_URL = 'https://api.groq.com/openai/v1'
const GROQ_ENV_KEY = 'GROQ_API_KEY'

export function groqApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MERCURY_GROQ_API_BASE?.trim() || GROQ_API_BASE_URL).replace(/\/+$/, '')
}

export function groqChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${groqApiBase(env)}/chat/completions`
}

export function groqEnvKey(env: NodeJS.ProcessEnv = process.env): { key: string; name: 'GROQ_API_KEY' } | undefined {
  const key = env[GROQ_ENV_KEY]?.trim()
  return key ? { key, name: GROQ_ENV_KEY } : undefined
}

export function resolveGroqApiKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'stored' } | undefined {
  const key = groqEnvKey(env)
  if (key) return { key: key.key, source: 'env' }
  const stored = readStoredGroqApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

interface GroqAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveGroqAccount(env: NodeJS.ProcessEnv = process.env): GroqAccountRef | undefined {
  const key = resolveGroqApiKey(env)
  return key ? { kind: 'api-key', label: key.source === 'env' ? `${GROQ_ENV_KEY} (env)` : 'Groq API key (stored, auth-scoped)', keySource: key.source } : undefined
}
