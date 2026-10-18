import { readStoredZaiApiKey, readStoredZaiKeyPlan } from '../providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'

export function resolveZaiApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const envKey = env.ZAI_API_KEY?.trim()
  if (envKey) return envKey
  const fromCommand = resolveProviderKeyCommand('zai')
  if (fromCommand) return fromCommand
  return readStoredZaiApiKey()
}

export function resolveZaiDispatch(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored'; plan: 'general' | 'coding' } | undefined {
  const envKey = env.ZAI_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env', plan: 'general' }
  const fromCommand = resolveProviderKeyCommand('zai')
  if (fromCommand) return { key: fromCommand, source: 'stored', plan: 'general' }
  const stored = readStoredZaiApiKey()
  if (!stored) return undefined
  return { key: stored, source: 'stored', plan: readStoredZaiKeyPlan() === 'coding' ? 'coding' : 'general' }
}
