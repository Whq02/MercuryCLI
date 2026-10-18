import { createHash } from 'node:crypto'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { configuredCompatEndpoints, resolveCompatApiKey, type CompatEndpoint } from './compatAccounts.js'

interface CompatCatalogue {
  models: string[]
  fetchedAtMs: number
  attemptedAtMs: number
  error?: string
}
const cache = new Map<string, CompatCatalogue>()
const inFlight = new Map<string, Promise<CompatCatalogue>>()

function identity(endpoint: CompatEndpoint, env: NodeJS.ProcessEnv): string {
  return createHash('sha256').update(JSON.stringify([endpoint.name, endpoint.baseUrl, endpoint.headers, resolveCompatApiKey(env, endpoint.name)?.key])).digest('hex')
}

export function cachedCompatCatalogue(endpoint: CompatEndpoint, env: NodeJS.ProcessEnv = process.env): CompatCatalogue | undefined {
  return cache.get(identity(endpoint, env))
}

export function compatEndpointModelIds(endpoint: CompatEndpoint, env: NodeJS.ProcessEnv = process.env): string[] {
  return endpoint.models.length > 0 ? endpoint.models : cachedCompatCatalogue(endpoint, env)?.models ?? []
}

async function readModels(response: Response): Promise<string[]> {
  const ceiling = 4 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > ceiling) {
    await response.body?.cancel()
    throw new Error('models response exceeds 4194304 bytes')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('models endpoint returned no body')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > ceiling) throw new Error('models response exceeds 4194304 bytes')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  let body: unknown
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('models endpoint returned invalid JSON') }
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { data?: unknown }).data)) throw new Error('models endpoint returned no data array')
  const rows = (body as { data: unknown[] }).data
  if (rows.some(row => typeof row !== 'object' || row === null || typeof (row as { id?: unknown }).id !== 'string' || !(row as { id: string }).id.trim())) throw new Error('models endpoint returned a row without a model id')
  return [...new Set(rows.map(row => (row as { id: string }).id.trim()))]
}

export async function refreshCompatCatalogues(opts: { force?: boolean; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<void> {
  const env = opts.env ?? process.env
  await Promise.all(configuredCompatEndpoints(env).map(async endpoint => {
    if (!endpoint.named || endpoint.models.length > 0 || !catalogueTrafficVerdict('openai-compat', env).allowed) return
    const id = identity(endpoint, env)
    const cached = cache.get(id)
    if (!opts.force && cached && Date.now() - cached.attemptedAtMs < (cached.error ? 10_000 : 300_000)) return
    const pending = inFlight.get(id)
    if (pending) { await pending; return }
    const key = resolveCompatApiKey(env, endpoint.name)?.key
    const work = (async (): Promise<CompatCatalogue> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      timer.unref?.()
      try {
        const response = await (opts.fetchImpl ?? getApiFetch())(`${endpoint.baseUrl}/models`, {
          headers: { ...endpoint.headers, accept: 'application/json', 'user-agent': getUserAgent(), ...(key ? { authorization: `Bearer ${key}` } : {}) },
          signal: controller.signal,
          redirect: 'error',
          ...getProxyFetchOptions(),
        } as RequestInit)
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error(`models endpoint returned HTTP ${response.status}`)
        }
        const models = await readModels(response)
        const result = { models, fetchedAtMs: Date.now(), attemptedAtMs: Date.now() }
        cache.set(id, result)
        return result
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const result = { models: [], fetchedAtMs: 0, attemptedAtMs: Date.now(), error: key ? detail.split(key).join('[redacted]') : detail }
        cache.set(id, result)
        return result
      } finally {
        clearTimeout(timer)
        inFlight.delete(id)
        bumpCatalogueEpoch()
      }
    })()
    inFlight.set(id, work)
    await work
  }))
}

export function namedCompatModelOptions(): import('../../../utils/model/modelOptions.js').ModelOption[] {
  const endpoints = configuredCompatEndpoints().filter(endpoint => endpoint.named)
  if (endpoints.length === 0) return []
  void refreshCompatCatalogues()
  return endpoints.flatMap(endpoint => {
    const models = compatEndpointModelIds(endpoint)
    const group = `Custom endpoint · ${endpoint.label} (${endpoint.name})`
    const snapshot = cachedCompatCatalogue(endpoint)
    return models.length ? models.map(id => ({ value: `compat/${endpoint.name}/${id}`, label: id, description: '', group })) : [{
      value: `__mercury_connect__:compat/${endpoint.name}`, label: `${endpoint.label} — no models listed`, group,
      description: snapshot?.error ?? 'The endpoint has not listed a model; set compatProvider models or refresh /model.',
    }]
  })
}
