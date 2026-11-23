import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { readStoredTogetherApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

const TOGETHER_API_BASE_URL = 'https://api.together.ai/v1'
export const TOGETHER_ENV_KEY = 'TOGETHER_API_KEY'
const TOGETHER_ENV_KEY_ALT = 'TOGETHER_AI_API_KEY'

export function togetherApiBase(env: NodeJS.ProcessEnv = hostEnv()): string {
  return (flagEnv('MERCURY_TOGETHER_API_BASE', env)?.trim() || TOGETHER_API_BASE_URL).replace(/\/+$/, '')
}

export function togetherChatCompletionsUrl(env: NodeJS.ProcessEnv = hostEnv()): string {
  return `${togetherApiBase(env)}/chat/completions`
}

export function togetherEnvKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; name: 'TOGETHER_API_KEY' | 'TOGETHER_AI_API_KEY' } | undefined {
  const primary = env[TOGETHER_ENV_KEY]?.trim()
  if (primary) return { key: primary, name: TOGETHER_ENV_KEY }
  const alternate = env[TOGETHER_ENV_KEY_ALT]?.trim()
  return alternate ? { key: alternate, name: TOGETHER_ENV_KEY_ALT } : undefined
}

export function resolveTogetherApiKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; source: 'env' | 'stored' } | undefined {
  const key = togetherEnvKey(env)
  if (key) return { key: key.key, source: 'env' }
  const fromCommand = resolveProviderKeyCommand('together')
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredTogetherApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

interface TogetherAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveTogetherAccount(env: NodeJS.ProcessEnv = hostEnv()): TogetherAccountRef | undefined {
  const key = resolveTogetherApiKey(env)
  if (!key) return undefined
  const envName = togetherEnvKey(env)?.name ?? TOGETHER_ENV_KEY
  return { kind: 'api-key', label: key.source === 'env' ? `${envName} (env)` : 'Together AI API key (stored, auth-scoped)', keySource: key.source }
}
