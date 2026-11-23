import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { readStoredMistralAdminApiKey, readStoredMistralApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export function mistralApiBase(env: NodeJS.ProcessEnv = hostEnv()): string {
  return (flagEnv('MERCURY_MISTRAL_API_BASE', env)?.trim() || 'https://api.mistral.ai/v1').replace(/\/+$/, '')
}

export function mistralChatCompletionsUrl(env: NodeJS.ProcessEnv = hostEnv()): string {
  return `${mistralApiBase(env)}/chat/completions`
}

export function mistralEnvKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; name: 'MISTRAL_API_KEY' } | undefined {
  const key = env.MISTRAL_API_KEY?.trim()
  return key ? { key, name: 'MISTRAL_API_KEY' } : undefined
}

export function resolveMistralApiKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; source: 'env' | 'stored' } | undefined {
  const key = mistralEnvKey(env)
  if (key) return { key: key.key, source: 'env' }
  const fromCommand = resolveProviderKeyCommand('mistral')
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredMistralApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export function resolveMistralAdminApiKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; source: 'env' | 'stored' } | undefined {
  const key = env.MISTRAL_ADMIN_API_KEY?.trim()
  if (key) return { key, source: 'env' }
  const stored = readStoredMistralAdminApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface MistralAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveMistralAccount(env: NodeJS.ProcessEnv = hostEnv()): MistralAccountRef | undefined {
  const key = resolveMistralApiKey(env)
  return key ? { kind: 'api-key', label: key.source === 'env' ? 'MISTRAL_API_KEY (env)' : 'Mistral API key (stored, auth-scoped)', keySource: key.source } : undefined
}

export function mistralKeyHeaders(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, 'x-api-key': key }
}
