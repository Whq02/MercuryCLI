import { getGlobalConfig } from '../../../utils/config.js'
import { getSettingsForSource } from '../../../utils/settings/settings.js'
import { COMPAT_ENDPOINT_NAME, CompatEndpointSchema, CompatProviderSchema, type CompatEndpointSettings } from '../../../utils/settings/compatProvider.js'
import { readStoredCompatApiKey } from '../providerSecrets.js'
import { configuredProviderKeyCommand, resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { COMPAT_MODEL_PREFIX } from '../idSpaces.js'

export interface CompatEndpoint extends CompatEndpointSettings {
  name: string
  named: boolean
  baseUrl: string
  label: string
  models: string[]
}

function configBlock(): unknown {
  let block: unknown
  try {
    block = getGlobalConfig().compatProvider
  } catch {}
  for (const source of ['userSettings', 'flagSettings', 'policySettings'] as const) {
    const value = getSettingsForSource(source)?.compatProvider
    if (value !== undefined) block = value
  }
  return block ?? {}
}

export function configuredCompatEndpoints(env: NodeJS.ProcessEnv = process.env): CompatEndpoint[] {
  const parsed = CompatProviderSchema().safeParse(configBlock())
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`compatProvider${issue?.path.length ? `.${issue.path.join('.')}` : ''}: ${issue?.message ?? 'invalid endpoint settings'}`)
  }
  const block = parsed.data
  const named = !CompatEndpointSchema().safeParse(block).success
  const entries: Array<[string, CompatEndpointSettings]> = named
    ? Object.entries(block) as Array<[string, CompatEndpointSettings]>
    : [['default', block as CompatEndpointSettings]]
  if (named && !Object.hasOwn(block, 'default') && env.MERCURY_COMPAT_BASE_URL?.trim()) entries.unshift(['default', {}])
  const endpoints: CompatEndpoint[] = []
  for (const [name, entry] of entries) {
    const baseUrl = (name === 'default' ? env.MERCURY_COMPAT_BASE_URL?.trim() || entry.baseUrl?.trim() : entry.baseUrl?.trim())?.replace(/\/+$/, '')
    if (!baseUrl) continue
    const validated = CompatProviderSchema().safeParse({ baseUrl })
    if (!validated.success) throw new Error(`compatProvider.${name}.baseUrl: must be an http(s) URL without credentials, query or fragment`)
    const label = (name === 'default' ? env.MERCURY_COMPAT_LABEL?.trim() : undefined) || entry.label?.trim() || (named ? name : 'Custom endpoint')
    const envModels = name === 'default' ? env.MERCURY_COMPAT_MODELS?.trim() : undefined
    const models = envModels ? envModels.split(',').map(id => id.trim()).filter(Boolean) : (entry.models ?? []).map(id => id.trim()).filter(Boolean)
    endpoints.push({ ...entry, name, named, baseUrl, label, models })
  }
  return endpoints
}

export function resolveCompatSlotConfig(env: NodeJS.ProcessEnv = process.env, name = 'default'): { baseUrl: string; label: string; models: string[] } | undefined {
  const endpoint = configuredCompatEndpoints(env).find(entry => entry.name === name)
  return endpoint ? { baseUrl: endpoint.baseUrl, label: endpoint.label, models: endpoint.models } : undefined
}

export function compatModelEndpoint(model: string, env: NodeJS.ProcessEnv = process.env, known?: CompatEndpoint[]): { endpoint: CompatEndpoint; wireId: string } | undefined {
  const raw = model.trim().replace(/\[(?:[0-9]+m|served)\]/gi, '')
  if (!raw.toLowerCase().startsWith(COMPAT_MODEL_PREFIX)) return undefined
  const inner = raw.slice(COMPAT_MODEL_PREFIX.length)
  const endpoints = known ?? configuredCompatEndpoints(env)
  const named = endpoints.some(endpoint => endpoint.named)
  if (!named) {
    const endpoint = endpoints.find(entry => entry.name === 'default')
    return endpoint && inner ? { endpoint, wireId: inner } : undefined
  }
  const slash = inner.indexOf('/')
  if (slash < 1 || slash === inner.length - 1) return undefined
  const name = inner.slice(0, slash)
  if (!COMPAT_ENDPOINT_NAME.test(name)) return undefined
  const endpoint = endpoints.find(entry => entry.name === name)
  return endpoint ? { endpoint, wireId: inner.slice(slash + 1) } : undefined
}

export function compatChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env, name = 'default'): string | undefined {
  const config = resolveCompatSlotConfig(env, name)
  return config ? `${config.baseUrl}/chat/completions` : undefined
}

export function compatKeyEnvName(name: string): string {
  if (!COMPAT_ENDPOINT_NAME.test(name)) throw new Error(`compatProvider.${name}: endpoint names must match [a-z0-9-]{1,32}`)
  return `MERCURY_COMPAT_${name.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

export function resolveCompatApiKey(env: Record<string, string | undefined> = process.env, name = 'default'): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = (name === 'default' ? env.MERCURY_COMPAT_API_KEY?.trim() : undefined) || env[compatKeyEnvName(name)]?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const fromCommand = resolveProviderKeyCommand(`compat:${name}`)
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredCompatApiKey(name)
  return stored ? { key: stored, source: 'stored' } : undefined
}

function compatEndpointAccount(endpoint: CompatEndpoint, env: NodeJS.ProcessEnv): { kind: 'api-key' | 'keyless'; label: string; keySource?: 'env' | 'stored' } | undefined {
  const key = resolveCompatApiKey(env, endpoint.name)
  if (key) {
    const envName = endpoint.name === 'default' && env.MERCURY_COMPAT_API_KEY?.trim() ? 'MERCURY_COMPAT_API_KEY' : compatKeyEnvName(endpoint.name)
    return { kind: 'api-key', label: key.source === 'env' ? `${endpoint.label} — ${envName} (env)` : `${endpoint.label} — API key (stored, auth-scoped)`, keySource: key.source }
  }
  if (configuredProviderKeyCommand(`compat:${endpoint.name}`)) return undefined
  return { kind: 'keyless', label: `${endpoint.label} — no key (local/auth-free endpoint)` }
}

export function resolveCompatAccount(env: NodeJS.ProcessEnv = process.env, name?: string): { kind: 'api-key' | 'keyless'; label: string; keySource?: 'env' | 'stored' } | undefined {
  for (const endpoint of configuredCompatEndpoints(env)) {
    if (name !== undefined && endpoint.name !== name) continue
    const account = compatEndpointAccount(endpoint, env)
    if (account) return account
  }
  return undefined
}

export function isCompatEndpointCredentialed(endpoint: CompatEndpoint, env: NodeJS.ProcessEnv = process.env): boolean {
  return compatEndpointAccount(endpoint, env) !== undefined
}

export function compatCredentialReader(env: NodeJS.ProcessEnv = process.env): { credentialed(model: string): boolean; refusalEndpoint(model?: string): string | undefined } {
  const endpoints = configuredCompatEndpoints(env)
  const verdicts = new Map<string, boolean>()
  const endpointCredentialed = (endpoint: CompatEndpoint): boolean => {
    let verdict = verdicts.get(endpoint.name)
    if (verdict === undefined) {
      verdict = compatEndpointAccount(endpoint, env) !== undefined
      verdicts.set(endpoint.name, verdict)
    }
    return verdict
  }
  return {
    credentialed(model) {
      if (model === 'openai-compat') return endpoints.some(endpointCredentialed)
      const resolved = compatModelEndpoint(model, env, endpoints)
      return resolved !== undefined && endpointCredentialed(resolved.endpoint)
    },
    refusalEndpoint(model) {
      if (model !== undefined && model !== 'openai-compat') {
        const resolved = compatModelEndpoint(model, env, endpoints)
        return resolved?.endpoint.named ? resolved.endpoint.name : undefined
      }
      return endpoints.find(endpoint => endpoint.named && !endpointCredentialed(endpoint))?.name
    },
  }
}

export function isCompatModelCredentialed(model: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return compatCredentialReader(env).credentialed(model)
}

export function compatSlotModelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const { compatEndpointModelIds } = require('./compatCatalogue.js') as typeof import('./compatCatalogue.js')
  return configuredCompatEndpoints(env).flatMap(endpoint => compatEndpointModelIds(endpoint, env).map(id => `${COMPAT_MODEL_PREFIX}${endpoint.named ? `${endpoint.name}/` : ''}${id}`))
}

export function compatModelRefusal(model: string): string | undefined {
  const resolved = compatModelEndpoint(model)
  if (!resolved) return `Model '${model}' has no configured endpoint in compatProvider; mercury://models lists the available endpoint models.`
  if (!resolved.endpoint.named) return undefined
  const { cachedCompatCatalogue, compatEndpointModelIds } = require('./compatCatalogue.js') as typeof import('./compatCatalogue.js')
  const listed = compatEndpointModelIds(resolved.endpoint)
  const cached = cachedCompatCatalogue(resolved.endpoint)
  if ((resolved.endpoint.models.length > 0 || cached?.fetchedAtMs) && !listed.includes(resolved.wireId)) return `Model '${model}' is not listed by endpoint '${resolved.endpoint.name}'; mercury://models lists the available endpoint models.`
  return undefined
}
