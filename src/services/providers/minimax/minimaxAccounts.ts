import { readStoredMinimaxApiKey } from '../providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'

const MINIMAX_API_BASE_URL = 'https://api.minimax.io/v1'
export const MINIMAX_ENV_KEY = 'MINIMAX_API_KEY'

export function minimaxApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MERCURY_MINIMAX_API_BASE?.trim() || MINIMAX_API_BASE_URL).replace(/\/+$/, '')
}

export function minimaxChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${minimaxApiBase(env)}/chat/completions`
}

function minimaxModelsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${minimaxApiBase(env)}/models`
}

export function minimaxPlanRemainsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${minimaxApiBase(env)}/token_plan/remains`
}

export function minimaxEnvKey(env: NodeJS.ProcessEnv = process.env): { key: string; name: 'MINIMAX_API_KEY' } | undefined {
  const key = env[MINIMAX_ENV_KEY]?.trim()
  return key ? { key, name: MINIMAX_ENV_KEY } : undefined
}

export function resolveMinimaxApiKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'stored' } | undefined {
  const key = minimaxEnvKey(env)
  if (key) return { key: key.key, source: 'env' }
  const fromCommand = resolveProviderKeyCommand('minimax')
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredMinimaxApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

interface MinimaxAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveMinimaxAccount(env: NodeJS.ProcessEnv = process.env): MinimaxAccountRef | undefined {
  const key = resolveMinimaxApiKey(env)
  return key ? { kind: 'api-key', label: key.source === 'env' ? `${MINIMAX_ENV_KEY} (env)` : 'MiniMax API key (stored, auth-scoped)', keySource: key.source } : undefined
}
