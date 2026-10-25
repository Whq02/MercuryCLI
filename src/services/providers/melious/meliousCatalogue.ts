import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { qualifiedWireId } from '../routeLaw.js'
import { meliousApiBase, resolveMeliousApiKey } from './meliousAccounts.js'

interface MeliousModel {
  id: string
  contextWindow?: number
  outputMax?: number
  reasoning?: boolean
  reasoningType?: 'reasoning' | 'non_reasoning' | 'hybrid'
  defaultEffort?: string
  images?: boolean
  tools?: boolean
  pricing?: { inputPerMtokEUR: number; outputPerMtokEUR: number; cacheReadPerMtokEUR?: number }
}

const object = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
const price = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export function isMeliousModelId(id: string): boolean { return id.trim().toLowerCase().startsWith('melious/') }
export function meliousWireId(id: string): string { return qualifiedWireId(id).replace(/\[(?:[0-9]+m|served)\]/gi, '') }
function baseId(id: string): string { return meliousWireId(id).replace(/:(?:balanced|speed|price|eco|batch|free)$/i, '') }

function decodeModel(raw: unknown): MeliousModel | undefined {
  const row = object(raw)
  const meta = object(row?._meta)
  if (typeof row?.id !== 'string' || !/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9_-]+)?$/i.test(row.id) || meta?.type !== 'chat') return undefined
  const capabilities = object(meta.capabilities)
  const rates = object(meta.pricing)
  const input = price(rates?.input_cost_per_million_eur)
  const output = price(rates?.output_cost_per_million_eur)
  const cacheRead = price(rates?.cache_read_cost_per_million_eur)
  const reasoningType = meta.reasoning_type
  return {
    id: row.id,
    ...(positive(meta.context_length) !== undefined ? { contextWindow: positive(meta.context_length) } : {}),
    ...(positive(meta.max_output_tokens) !== undefined ? { outputMax: positive(meta.max_output_tokens) } : {}),
    ...(typeof capabilities?.reasoning === 'boolean' ? { reasoning: capabilities.reasoning } : {}),
    ...(reasoningType === 'reasoning' || reasoningType === 'non_reasoning' || reasoningType === 'hybrid' ? { reasoningType } : {}),
    ...(typeof meta.reasoning_effort === 'string' ? { defaultEffort: meta.reasoning_effort } : {}),
    ...(Array.isArray(meta.input_modalities) ? { images: meta.input_modalities.includes('image') } : typeof capabilities?.vision === 'boolean' ? { images: capabilities.vision } : {}),
    ...(typeof capabilities?.function_calling === 'boolean' ? { tools: capabilities.function_calling } : {}),
    ...(rates?.currency === 'EUR' && input !== undefined && output !== undefined ? { pricing: { inputPerMtokEUR: input, outputPerMtokEUR: output, ...(cacheRead !== undefined ? { cacheReadPerMtokEUR: cacheRead } : {}) } } : {}),
  }
}

export class MeliousCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `Melious AI models endpoint refused the credential (HTTP ${status})` : `Melious AI models endpoint returned HTTP ${status}`)
  }
}

export async function fetchMeliousLiveModels(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): Promise<{ models: MeliousModel[]; otherLines: number; fetchedAtMs: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'melious', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models?include_meta=true`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) { throw modelsEndpointUnreachable(error) ?? error }
  if (!response.ok) throw new MeliousCatalogueHttpError(response.status)
  const parsed = object(await catalogueBodyJson(response))
  if (!Array.isArray(parsed?.data)) throw new Error('Melious AI models endpoint returned no data array')
  const seen = new Set<string>()
  const models: MeliousModel[] = []
  let otherLines = 0
  for (const row of parsed.data) {
    const model = decodeModel(row)
    if (!model) { otherLines++; continue }
    if (seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  return { models, otherLines, fetchedAtMs: Date.now() }
}

export interface MeliousCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: MeliousModel[]
  otherLines: number
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}
const cache = new Map<string, MeliousCatalogueSnapshot>()
const inFlight = new Map<string, Promise<MeliousCatalogueSnapshot | null>>()
function identityOf(env: NodeJS.ProcessEnv): string {
  const key = resolveMeliousApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${meliousApiBase(env)}` : 'none'
}
export function getCachedMeliousCatalogue(env: NodeJS.ProcessEnv = process.env): MeliousCatalogueSnapshot | null {
  return resolveMeliousApiKey(env) ? cache.get(identityOf(env)) ?? null : null
}
export function refreshMeliousCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<MeliousCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveMeliousApiKey(env)
  const identity = identityOf(env)
  const cached = key ? cache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('melious', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < (cached.lastError ? 10_000 : 300_000)) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const work = (async (): Promise<MeliousCatalogueSnapshot | null> => {
    try {
      const result = await fetchMeliousLiveModels({ baseUrl: meliousApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot = { keySource: key.source, ...result, fetchedAtMs: now() }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof MeliousCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: MeliousCatalogueSnapshot = {
        keySource: key.source, models: refused ? [] : cached?.models ?? [], otherLines: cached?.otherLines ?? 0, fetchedAtMs: refused ? 0 : cached?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(), lastError: (error instanceof Error ? error.message : String(error)).split(key.key).join('[redacted]'),
      }
      cache.set(identity, snapshot)
      return snapshot
    } finally { inFlight.delete(identity); bumpCatalogueEpoch() }
  })()
  inFlight.set(identity, work)
  return work
}

export function meliousListedModel(id: string, env: NodeJS.ProcessEnv = process.env): MeliousModel | undefined {
  const models = getCachedMeliousCatalogue(env)?.models
  const wire = meliousWireId(id).toLowerCase()
  return models?.find(row => row.id.toLowerCase() === wire) ?? models?.find(row => row.id.toLowerCase() === baseId(id).toLowerCase())
}
export function meliousEffortVocabulary(id: string): readonly string[] {
  const row = meliousListedModel(id)
  return row?.defaultEffort !== undefined ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : []
}
export function meliousContextWindowFor(id: string): number | undefined {
  return meliousListedModel(id)?.contextWindow
}
export function meliousOutputMaxFor(id: string): number | undefined { return meliousListedModel(id)?.outputMax }
export function meliousCatalogueRows(env: NodeJS.ProcessEnv = process.env) {
  const snapshot = getCachedMeliousCatalogue(env)
  const rows = (snapshot?.models ?? []).flatMap(model => {
    const ids = model.id.includes(':') ? [model.id] : [model.id, ...['speed', 'price', 'eco', 'batch'].map(flavor => `${model.id}:${flavor}`)]
    return ids.map(id => ({ id: `melious/${id}`, displayName: id, observedAt: new Date(snapshot!.fetchedAtMs).toISOString().slice(0, 10), contextWindow: model.contextWindow, listedLive: true }))
  })
  return { rows, source: snapshot && snapshot.fetchedAtMs > 0 ? { kind: 'live' as const, count: snapshot.models.length, otherLines: snapshot.otherLines, fetchedAtMs: snapshot.fetchedAtMs } : { kind: 'unread' as const } }
}
export function meliousPricingString(id: string): string | undefined {
  const pricing = meliousListedModel(id)?.pricing
  return pricing ? `€${pricing.inputPerMtokEUR}/€${pricing.outputPerMtokEUR} per Mtok` : undefined
}
