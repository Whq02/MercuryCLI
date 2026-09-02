//      global-config compatProvider block (env is the operator's louder
import { getGlobalConfig } from '../../../utils/config.js'
import { readStoredCompatApiKey } from '../../../utils/router/providerSecrets.js'
import { COMPAT_MODEL_PREFIX } from '../routeLaw.js'

export interface CompatSlotConfig {
  baseUrl: string
  label: string
  models: string[]
}

function configBlock(): { baseUrl?: string; label?: string; models?: string[] } {
  try {
    return getGlobalConfig().compatProvider ?? {}
  } catch {
    return {}
  }
}

export function resolveCompatSlotConfig(
  env: NodeJS.ProcessEnv = process.env,
): CompatSlotConfig | undefined {
  const block = configBlock()
  const baseUrl = (env['MERCURY_COMPAT_BASE_URL']?.trim() || block.baseUrl?.trim() || '').replace(
    /\/+$/,
    '',
  )
  if (!baseUrl) return undefined
  const label = env['MERCURY_COMPAT_LABEL']?.trim() || block.label?.trim() || 'Custom endpoint'
  const envModels = env['MERCURY_COMPAT_MODELS']?.trim()
  const models = envModels
    ? envModels.split(',').map(s => s.trim()).filter(Boolean)
    : (block.models ?? []).map(s => s.trim()).filter(Boolean)
  return { baseUrl, label, models }
}

export function compatChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const config = resolveCompatSlotConfig(env)
  return config ? `${config.baseUrl}/chat/completions` : undefined
}

export function resolveCompatApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env.MERCURY_COMPAT_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredCompatApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface CompatAccountRef {
  kind: 'api-key' | 'keyless'
  label: string
  keySource?: 'env' | 'stored'
}

export function resolveCompatAccount(
  env: NodeJS.ProcessEnv = process.env,
): CompatAccountRef | undefined {
  const config = resolveCompatSlotConfig(env)
  if (!config) return undefined
  const key = resolveCompatApiKey(env)
  if (key) {
    return {
      kind: 'api-key',
      label:
        key.source === 'env'
          ? `${config.label} — MERCURY_COMPAT_API_KEY (env)`
          : `${config.label} — API key (stored, auth-scoped)`,
      keySource: key.source,
    }
  }
  return { kind: 'keyless', label: `${config.label} — no key (local/auth-free endpoint)` }
}

export function compatSlotModelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = resolveCompatSlotConfig(env)
  if (!config) return []
  return config.models.map(id => `${COMPAT_MODEL_PREFIX}${id}`)
}
