import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { readStoredDeepseekApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com'

export function deepseekApiBase(env: NodeJS.ProcessEnv = hostEnv()): string {
  return flagEnv('MERCURY_DEEPSEEK_API_BASE', env)?.trim() || DEEPSEEK_API_BASE_URL
}
export function deepseekChatCompletionsUrl(env: NodeJS.ProcessEnv = hostEnv()): string {
  return `${deepseekApiBase(env)}/chat/completions`
}
export function deepseekBalanceUrl(env: NodeJS.ProcessEnv = hostEnv()): string {
  return `${deepseekApiBase(env)}/user/balance`
}

export function resolveDeepseekApiKey(
  env: Record<string, string | undefined> = hostEnv(),
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env.DEEPSEEK_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const fromCommand = resolveProviderKeyCommand('deepseek')
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredDeepseekApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

interface DeepseekAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveDeepseekAccount(
  env: NodeJS.ProcessEnv = hostEnv(),
): DeepseekAccountRef | undefined {
  const key = resolveDeepseekApiKey(env)
  if (!key) return undefined
  return {
    kind: 'api-key',
    label: key.source === 'env' ? 'DEEPSEEK_API_KEY (env)' : 'DeepSeek API key (stored, auth-scoped)',
    keySource: key.source,
  }
}
