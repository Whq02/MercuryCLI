import { readStoredZaiApiKey, readStoredZaiKeyPlan } from '../providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { planlessZaiKeyPlan, type ZaiKeyPlanWord, type ZaiPlanSource } from './zaiKeyPlan.js'

export interface ZaiDispatch {
  key: string
  source: 'env' | 'stored'
  plan: ZaiKeyPlanWord
  planSource: ZaiPlanSource
}

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
): ZaiDispatch | undefined {
  const envKey = env.ZAI_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env', ...planlessZaiKeyPlan(envKey, env) }
  const fromCommand = resolveProviderKeyCommand('zai')
  if (fromCommand) return { key: fromCommand, source: 'stored', ...planlessZaiKeyPlan(fromCommand, env) }
  const stored = readStoredZaiApiKey()
  if (!stored) return undefined
  return { key: stored, source: 'stored', plan: readStoredZaiKeyPlan() === 'coding' ? 'coding' : 'general', planSource: 'stored' }
}
