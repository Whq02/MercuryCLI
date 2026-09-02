// ============================================================================
//  providers/openaicompat/compatAccounts — the operator-named OpenAI-
//  compatible endpoint slot's config + credential owner:
// ONE slot covering vLLM · LM Studio · Ollama · corporate
//  proxies · any OpenAI-compatible vendor: a base URL, an optional key, an
//  operator-named model list, one display label.
//
//  Resolution laws:
//    · every field: registered MERCURY_COMPAT_* env flag WINS over the
//      global-config compatProvider block (env is the operator's louder
//      word);
//    · the key: env MERCURY_COMPAT_API_KEY > the auth-scoped provider-secret
//      store; a MISSING key is legal (local servers run auth-free) — the
//      slot is CONFIGURED iff a base URL exists;
//    · model ids are the operator's bare vendor ids; Mercury addresses them
//      as compat/<id> (the routing-law namespace) and the prefix never rides
//      the wire;
//    · values never enter logs/records — presence + labels only.
// ============================================================================
import { getGlobalConfig } from '../../../utils/config.js'
import { readStoredCompatApiKey } from '../../../utils/router/providerSecrets.js'
import { COMPAT_MODEL_PREFIX } from '../routeLaw.js'

export interface CompatSlotConfig {
  baseUrl: string
  /** Display words ('LM Studio', 'corp proxy', …); defaults honestly. */
  label: string
  /** Bare vendor ids the operator named (may be empty — /models can serve
   *  live discovery on servers that offer it; a later live window wires it). */
  models: string[]
}

function configBlock(): { baseUrl?: string; label?: string; models?: string[] } {
  // A config store that is not armed (early boot, schema-only tool builds,
  // hermetic provers) reads as UNCONFIGURED — the slot's honest dark state,
  // never a throw out of a read path.
  try {
    return getGlobalConfig().compatProvider ?? {}
  } catch {
    return {}
  }
}

/** The slot's config, env-first; undefined until a base URL exists. */
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

/** The slot's key: env wins; absence is a legal state, not a refusal. */
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

/** The slot's account view — present iff the slot is configured. */
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

/** The operator's models as picker-addressable ids (compat/<vendor-id>). */
export function compatSlotModelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = resolveCompatSlotConfig(env)
  if (!config) return []
  return config.models.map(id => `${COMPAT_MODEL_PREFIX}${id}`)
}
