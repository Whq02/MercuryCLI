import { readStoredMeliousApiKey } from '../providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'

const MELIOUS_API_BASE_URL = 'https://api.melious.ai/v1'
const MELIOUS_ENV_KEY = 'MELIOUS_API_KEY'

export function meliousApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MERCURY_MELIOUS_API_BASE?.trim() || MELIOUS_API_BASE_URL).replace(/\/+$/, '')
}

export function meliousChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${meliousApiBase(env)}/chat/completions`
}

export function meliousEnvKey(env: NodeJS.ProcessEnv = process.env): { key: string; name: 'MELIOUS_API_KEY' } | undefined {
  const key = env[MELIOUS_ENV_KEY]?.trim()
  return key ? { key, name: MELIOUS_ENV_KEY } : undefined
}

export function resolveMeliousApiKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'stored' } | undefined {
  const key = meliousEnvKey(env)
  if (key) return { key: key.key, source: 'env' }
  const fromCommand = resolveProviderKeyCommand('melious')
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredMeliousApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

interface MeliousAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveMeliousAccount(env: NodeJS.ProcessEnv = process.env): MeliousAccountRef | undefined {
  const key = resolveMeliousApiKey(env)
  return key ? { kind: 'api-key', label: key.source === 'env' ? `${MELIOUS_ENV_KEY} (env)` : 'Melious AI API key (stored)', keySource: key.source } : undefined
}
