import { createHash } from 'node:crypto'
import { readHostRecord } from '../../host/store.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { configuredCompatEndpoints, compatModelEndpoint, isCompatEndpointCredentialed, resolveCompatApiKey, type CompatEndpoint } from './compatAccounts.js'
import { inspectCompatServer, type CompatServerReading } from './compatProbe.js'

interface CompatCatalogue extends CompatServerReading {
  fetchedAtMs: number
  attemptedAtMs: number
  error?: string
}
const cache = new Map<string, CompatCatalogue>()
const inFlight = new Map<string, Promise<CompatCatalogue>>()

function identity(endpoint: CompatEndpoint, env: NodeJS.ProcessEnv): string {
  return createHash('sha256').update(JSON.stringify([endpoint.name, endpoint.baseUrl, endpoint.headers, endpoint.dialect, resolveCompatApiKey(env, endpoint.name)?.key])).digest('hex')
}

export function cachedCompatCatalogue(endpoint: CompatEndpoint, env: NodeJS.ProcessEnv = process.env): CompatCatalogue | undefined {
  return cache.get(identity(endpoint, env))
}

export function compatEndpointModelIds(endpoint: CompatEndpoint, env: NodeJS.ProcessEnv = process.env): string[] {
  return endpoint.models.length > 0 ? endpoint.models : cachedCompatCatalogue(endpoint, env)?.models ?? []
}

export function compatContextWindowFor(model: string): number | undefined {
  const resolved = compatModelEndpoint(model)
  return resolved ? cachedCompatCatalogue(resolved.endpoint)?.contextWindows[resolved.wireId] : undefined
}

export function rememberCompatCatalogue(endpoint: CompatEndpoint, reading: CompatServerReading): void {
  cache.set(identity(endpoint, process.env), { ...reading, fetchedAtMs: Date.now(), attemptedAtMs: Date.now() })
  bumpCatalogueEpoch()
}

export async function refreshCompatCatalogues(opts: { force?: boolean; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; name?: string; signal?: AbortSignal } = {}): Promise<void> {
  const env = opts.env ?? process.env
  await Promise.all(configuredCompatEndpoints(env).map(async endpoint => {
    if (!endpoint.named || (opts.name !== undefined && endpoint.name !== opts.name) || !catalogueTrafficVerdict('openai-compat', env).allowed) return
    const id = identity(endpoint, env)
    const cached = cache.get(id)
    if (!opts.force && cached && Date.now() - cached.attemptedAtMs < (cached.error ? 10_000 : 300_000)) return
    const pending = inFlight.get(id)
    if (pending) { await pending; return }
    const key = resolveCompatApiKey(env, endpoint.name)?.key
    const work = (async (): Promise<CompatCatalogue> => {
      try {
        const reading = await inspectCompatServer(endpoint, { key, fetchImpl: opts.fetchImpl, signal: opts.signal })
        const result = { ...reading, fetchedAtMs: Date.now(), attemptedAtMs: Date.now() }
        cache.set(id, result)
        return result
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const result = { models: [], contextWindows: {}, fetchedAtMs: 0, attemptedAtMs: Date.now(), error: key ? detail.split(key).join('[redacted]') : detail }
        cache.set(id, result)
        return result
      } finally {
        inFlight.delete(id)
        bumpCatalogueEpoch()
      }
    })()
    inFlight.set(id, work)
    await work
  }))
}

export function compatEndpointPodTerminated(endpoint: CompatEndpoint): boolean {
  return Boolean(endpoint.hostPodId && !readHostRecord(endpoint.hostPodId))
}

export function compatCatalogueStatusWords(endpoint: CompatEndpoint): string {
  if (compatEndpointPodTerminated(endpoint)) return `${endpoint.label} · pod terminated — /llmhost rents again`
  const snapshot = cachedCompatCatalogue(endpoint)
  if (snapshot?.error) return `${endpoint.label} · server at ${new URL(endpoint.baseUrl).host} not answering (${snapshot.error}) — ↵ retries · /llmhost checks it`
  return `${endpoint.label} · ${snapshot ? 'no models listed' : 'reading models'} — ↵ retries · /llmhost checks it`
}

export function namedCompatModelOptions(): import('../../../utils/model/modelOptions.js').ModelOption[] {
  const endpoints = configuredCompatEndpoints().filter(endpoint => endpoint.named)
  if (endpoints.length === 0) return []
  void refreshCompatCatalogues()
  return endpoints.flatMap(endpoint => {
    const models = compatEndpointModelIds(endpoint)
    const group = `Custom endpoint · ${endpoint.label} (${endpoint.name})`
    const snapshot = cachedCompatCatalogue(endpoint)
    const credentialed = isCompatEndpointCredentialed(endpoint)
    if (!credentialed) return [{ value: `__mercury_connect__:compat/${endpoint.name}`, label: `${endpoint.label} · needs a key — /logins compat/${endpoint.name}`, group, description: `The endpoint '${endpoint.name}' needs a key: /logins compat/${endpoint.name}` }]
    const unavailable = Boolean(snapshot?.error || compatEndpointPodTerminated(endpoint))
    return models.length && !unavailable ? models.map(id => ({
      value: `compat/${endpoint.name}/${id}`,
      label: id,
      description: resolveCompatApiKey(process.env, endpoint.name) ? '' : 'no key (local/auth-free endpoint)',
      group,
    })) : [{
      value: `__mercury_connect__:compat/${endpoint.name}`, label: compatCatalogueStatusWords(endpoint), group,
      description: compatCatalogueStatusWords(endpoint),
    }]
  })
}
