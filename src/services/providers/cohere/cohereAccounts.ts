import { readStoredCohereApiKey } from '../providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'

const COHERE_API_BASE_URL = 'https://api.cohere.ai/compatibility/v1'
export const COHERE_ENV_KEY = 'COHERE_API_KEY'
const COHERE_ENV_KEY_ALT = 'CO_API_KEY'

export function cohereApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MERCURY_COHERE_API_BASE?.trim() || COHERE_API_BASE_URL).replace(/\/+$/, '')
}

export function cohereChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${cohereApiBase(env)}/chat/completions`
}

function cohereModelsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${cohereApiBase(env)}/models`
}

export function cohereEnvKey(env: NodeJS.ProcessEnv = process.env): { key: string; name: 'COHERE_API_KEY' | 'CO_API_KEY' } | undefined {
  const primary = env[COHERE_ENV_KEY]?.trim()
  if (primary) return { key: primary, name: COHERE_ENV_KEY }
  const alternate = env[COHERE_ENV_KEY_ALT]?.trim()
  return alternate ? { key: alternate, name: COHERE_ENV_KEY_ALT } : undefined
}

export function resolveCohereApiKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'stored' } | undefined {
  const key = cohereEnvKey(env)
  if (key) return { key: key.key, source: 'env' }
  const fromCommand = resolveProviderKeyCommand('cohere')
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredCohereApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

interface CohereAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveCohereAccount(env: NodeJS.ProcessEnv = process.env): CohereAccountRef | undefined {
  const key = resolveCohereApiKey(env)
  if (!key) return undefined
  const envName = cohereEnvKey(env)?.name ?? COHERE_ENV_KEY
  return { kind: 'api-key', label: key.source === 'env' ? `${envName} (env)` : 'Cohere API key (stored, auth-scoped)', keySource: key.source }
}
