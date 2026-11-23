import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { readStoredMinimaxApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

const MINIMAX_API_BASE_URL = 'https://api.minimax.io/v1'
const MINIMAX_PLAN_BASE_URL = 'https://www.minimax.io/v1'
export const MINIMAX_ENV_KEY = 'MINIMAX_API_KEY'

export function minimaxApiBase(env: NodeJS.ProcessEnv = hostEnv()): string {
  return (flagEnv('MERCURY_MINIMAX_API_BASE', env)?.trim() || MINIMAX_API_BASE_URL).replace(/\/+$/, '')
}

export function minimaxChatCompletionsUrl(env: NodeJS.ProcessEnv = hostEnv()): string {
  return `${minimaxApiBase(env)}/chat/completions`
}

export function minimaxPlanRemainsUrl(env: NodeJS.ProcessEnv = hostEnv()): string {
  return `${(flagEnv('MERCURY_MINIMAX_API_BASE', env)?.trim() || MINIMAX_PLAN_BASE_URL).replace(/\/+$/, '')}/token_plan/remains`
}

export function minimaxEnvKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; name: 'MINIMAX_API_KEY' } | undefined {
  const key = env[MINIMAX_ENV_KEY]?.trim()
  return key ? { key, name: MINIMAX_ENV_KEY } : undefined
}

export function resolveMinimaxApiKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; source: 'env' | 'stored' } | undefined {
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

export function resolveMinimaxAccount(env: NodeJS.ProcessEnv = hostEnv()): MinimaxAccountRef | undefined {
  const key = resolveMinimaxApiKey(env)
  return key ? { kind: 'api-key', label: key.source === 'env' ? `${MINIMAX_ENV_KEY} (env)` : 'MiniMax API key (stored, auth-scoped)', keySource: key.source } : undefined
}
