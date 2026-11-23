import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { COMPAT_ENDPOINT_NAME } from '../../../platform/settings/compatProvider.js'
import { configuredCompatEndpoints, type CompatEndpoint } from '../../../platform/settings/compatEndpoints.js'
import { readStoredCompatApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { configuredProviderKeyCommand, resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { COMPAT_MODEL_PREFIX } from '../idSpaces.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export { configuredCompatEndpoints, type CompatEndpoint }

export function resolveCompatSlotConfig(env: NodeJS.ProcessEnv = hostEnv(), name = 'default'): { baseUrl: string; label: string; models: string[] } | undefined {
  const endpoint = configuredCompatEndpoints(env).find(entry => entry.name === name)
  return endpoint ? { baseUrl: endpoint.baseUrl, label: endpoint.label, models: endpoint.models } : undefined
}

export function compatModelEndpoint(model: string, env: NodeJS.ProcessEnv = hostEnv(), known?: CompatEndpoint[]): { endpoint: CompatEndpoint; wireId: string } | undefined {
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

export function compatChatCompletionsUrl(env: NodeJS.ProcessEnv = hostEnv(), name = 'default'): string | undefined {
  const config = resolveCompatSlotConfig(env, name)
  return config ? `${config.baseUrl}/chat/completions` : undefined
}

export function compatKeyEnvName(name: string): string {
  if (!COMPAT_ENDPOINT_NAME.test(name)) throw new Error(`compatProvider.${name}: endpoint names must match [a-z0-9-]{1,32}`)
  return `MERCURY_COMPAT_${name.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

export function resolveCompatApiKey(env: Record<string, string | undefined> = hostEnv(), name = 'default'): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = (name === 'default' ? flagEnv('MERCURY_COMPAT_API_KEY', env)?.trim() : undefined) || env[compatKeyEnvName(name)]?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const fromCommand = resolveProviderKeyCommand(`compat:${name}`)
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredCompatApiKey(name)
  return stored ? { key: stored, source: 'stored' } : undefined
}

function compatEndpointAccount(endpoint: CompatEndpoint, env: NodeJS.ProcessEnv): { kind: 'api-key' | 'keyless'; label: string; keySource?: 'env' | 'stored' } | undefined {
  const key = resolveCompatApiKey(env, endpoint.name)
  if (key) {
    const envName = endpoint.name === 'default' && flagEnv('MERCURY_COMPAT_API_KEY', env)?.trim() ? 'MERCURY_COMPAT_API_KEY' : compatKeyEnvName(endpoint.name)
    return { kind: 'api-key', label: key.source === 'env' ? `${endpoint.label} — ${envName} (env)` : `${endpoint.label} — API key (stored, auth-scoped)`, keySource: key.source }
  }
  if (configuredProviderKeyCommand(`compat:${endpoint.name}`)) return undefined
  const rental = endpoint.hostPodId ? rentedMachineWords(endpoint.hostPodId) : undefined
  return { kind: 'keyless', label: rental ? `${endpoint.label} — ${rental} (no key)` : `${endpoint.label} — no key (local/auth-free endpoint)` }
}

function rentedMachineWords(hostPodId: string): string | undefined {
  try {
    const { readHostRecord } = require('../../hosting/store.js') as typeof import('../../hosting/store.js')
    const { hostMachineName } = require('../../../commands/llmhost/words.js') as typeof import('../../../commands/llmhost/words.js')
    const record = readHostRecord(hostPodId)
    return record ? hostMachineName(record.vendor ?? 'runpod', record.id) + ' · $' + record.price.toFixed(2) + '/hr' : undefined
  } catch (error) { passedOver(error); return undefined }
}

export function resolveCompatAccount(env: NodeJS.ProcessEnv = hostEnv(), name?: string): { kind: 'api-key' | 'keyless'; label: string; keySource?: 'env' | 'stored' } | undefined {
  for (const endpoint of configuredCompatEndpoints(env)) {
    if (name !== undefined && endpoint.name !== name) continue
    const account = compatEndpointAccount(endpoint, env)
    if (account) return account
  }
  return undefined
}

export function isCompatEndpointCredentialed(endpoint: CompatEndpoint, env: NodeJS.ProcessEnv = hostEnv()): boolean {
  return compatEndpointAccount(endpoint, env) !== undefined
}

export function compatCredentialReader(env: NodeJS.ProcessEnv = hostEnv()): { credentialed(model: string): boolean; refusalEndpoint(model?: string): string | undefined } {
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

export function isCompatModelCredentialed(model: string, env: NodeJS.ProcessEnv = hostEnv()): boolean {
  return compatCredentialReader(env).credentialed(model)
}

export function compatSlotModelIds(env: NodeJS.ProcessEnv = hostEnv()): string[] {
  const { compatEndpointModelIds } = require('./compatCatalogue.js') as typeof import('./compatCatalogue.js')
  return configuredCompatEndpoints(env).flatMap(endpoint => compatEndpointModelIds(endpoint, env).map(id => `${COMPAT_MODEL_PREFIX}${endpoint.named ? `${endpoint.name}/` : ''}${id}`))
}

export function compatModelRefusal(model: string): string | undefined {
  const resolved = compatModelEndpoint(model)
  if (!resolved) return `Model '${model}' has no configured endpoint in compatProvider; mercury://models lists the available endpoint models.`
  const { boxEndpointNotice } = require('../../hosting/boxService.js') as typeof import('../../hosting/boxService.js')
  const boxNotice = boxEndpointNotice(resolved.endpoint.name, resolved.endpoint.baseUrl)
  if (boxNotice) return boxNotice
  if (!resolved.endpoint.named) return undefined
  const { cachedCompatCatalogue, compatEndpointModelIds } = require('./compatCatalogue.js') as typeof import('./compatCatalogue.js')
  const listed = compatEndpointModelIds(resolved.endpoint)
  const cached = cachedCompatCatalogue(resolved.endpoint)
  if ((resolved.endpoint.models.length > 0 || cached?.fetchedAtMs) && !listed.includes(resolved.wireId)) return `Model '${model}' is not listed by endpoint '${resolved.endpoint.name}'; mercury://models lists the available endpoint models.`
  return undefined
}
