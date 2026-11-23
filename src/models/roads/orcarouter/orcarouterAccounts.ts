import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { readStoredOrcarouterApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export function orcarouterApiBase(env: NodeJS.ProcessEnv = hostEnv()): string {
  return (flagEnv('MERCURY_ORCAROUTER_API_BASE', env)?.trim() || 'https://api.orcarouter.ai/v1').replace(/\/+$/, '')
}

function orcarouterEnvKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; name: 'ORCAROUTER_API_KEY' } | undefined {
  const key = env.ORCAROUTER_API_KEY?.trim()
  return key ? { key, name: 'ORCAROUTER_API_KEY' } : undefined
}

export function resolveOrcarouterApiKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; source: 'env' | 'stored' } | undefined {
  const ambient = orcarouterEnvKey(env)
  if (ambient) return { key: ambient.key, source: 'env' }
  const key = resolveProviderKeyCommand('orcarouter') ?? readStoredOrcarouterApiKey()
  return key ? { key, source: 'stored' } : undefined
}

export function resolveOrcarouterAccount(env: NodeJS.ProcessEnv = hostEnv()): { kind: 'api-key'; label: string; keySource: 'env' | 'stored' } | undefined {
  const key = resolveOrcarouterApiKey(env)
  return key ? { kind: 'api-key', label: key.source === 'env' ? 'ORCAROUTER_API_KEY (env)' : 'OrcaRouter API key (stored, auth-scoped)', keySource: key.source } : undefined
}
