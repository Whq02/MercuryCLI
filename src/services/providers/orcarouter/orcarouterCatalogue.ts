import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getProductUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { canonicalWireModelId } from '../routeLaw.js'
import { orcarouterApiBase, resolveOrcarouterApiKey } from './orcarouterAccounts.js'

const ORCAROUTER_OBSERVED_AT = '2026-10-24'
export const ORCAROUTER_DISPLAY_PINS = [
  { id: 'orcarouter/auto', displayName: 'OrcaRouter Auto' },
  { id: 'openai/gpt-4o-mini', displayName: 'openai/gpt-4o-mini' },
  { id: 'anthropic/claude-sonnet-4.6', displayName: 'anthropic/claude-sonnet-4.6' },
  { id: 'google/gemini-2.5-flash', displayName: 'google/gemini-2.5-flash' },
] as const

export function isOrcarouterModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith('orcarouter/')
}

export function orcarouterWireId(model: string): string {
  if (!isOrcarouterModelId(model)) return model.trim()
  const verdict = canonicalWireModelId(model)
  return verdict.ok ? verdict.wireId : ''
}

export function orcarouterQualifiedId(wireId: string): string {
  return `orcarouter/${wireId}`
}

export function orcarouterEffortVocabulary(_model: string): readonly string[] {
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
}

interface OrcarouterLiveModel {
  id: string
  displayName: string
  contextWindow?: number
  outputMax?: number
  inputModalities?: string[]
  pricing?: { prompt?: number; completion?: number }
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function price(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined
}

function decodeModel(raw: unknown): OrcarouterLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !canonicalWireModelId(orcarouterQualifiedId(row.id)).ok) return undefined
  const architecture = row.architecture as Record<string, unknown> | undefined
  const output = strings(architecture?.output_modalities)
  if (output && !output.includes('text')) return undefined
  const endpoints = strings(row.supported_endpoint_types)
  if (endpoints && !endpoints.some(value => ['openai', 'anthropic', 'gemini'].includes(value))) return undefined
  const prices = row.pricing as Record<string, unknown> | undefined
  const prompt = price(prices?.prompt) ?? (price(prices?.prompt_per_million) !== undefined ? price(prices?.prompt_per_million)! / 1e6 : undefined)
  const completion = price(prices?.completion) ?? (price(prices?.completion_per_million) !== undefined ? price(prices?.completion_per_million)! / 1e6 : undefined)
  return {
    id: row.id.trim(), displayName: typeof row.name === 'string' && row.name.trim() ? row.name : row.id.trim(),
    ...(positive(row.context_length) !== undefined ? { contextWindow: positive(row.context_length) } : {}),
    ...(positive(row.max_completion_tokens) !== undefined ? { outputMax: positive(row.max_completion_tokens) } : {}),
    ...(strings(architecture?.input_modalities) ? { inputModalities: strings(architecture?.input_modalities) } : {}),
    ...(prompt !== undefined || completion !== undefined ? { pricing: { prompt, completion } } : {}),
  }
}

export class OrcarouterCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `OrcaRouter models endpoint refused the credential (HTTP ${status})` : `OrcaRouter models endpoint returned HTTP ${status}`)
  }
}

export async function fetchOrcarouterLiveModels(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): Promise<{ models: OrcarouterLiveModel[]; otherLines: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'orcarouter', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models?capability=chat`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getProductUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) { throw modelsEndpointUnreachable(error) ?? error }
  if (!response.ok) throw new OrcarouterCatalogueHttpError(response.status)
  const parsed = await catalogueBodyJson(response) as Record<string, unknown>
  if (!Array.isArray(parsed?.data)) throw new Error('OrcaRouter models endpoint returned no data array')
  const seen = new Set<string>()
  const models: OrcarouterLiveModel[] = []
  let otherLines = 0
  for (const raw of parsed.data) {
    const model = decodeModel(raw)
    if (!model) { otherLines++; continue }
    if (seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  return { models, otherLines }
}

interface OrcarouterCatalogueSnapshot {
  models: OrcarouterLiveModel[]
  otherLines: number
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const cache = new Map<string, OrcarouterCatalogueSnapshot>()
const inFlight = new Map<string, Promise<OrcarouterCatalogueSnapshot | null>>()
function identityOf(env: NodeJS.ProcessEnv): string {
  const key = resolveOrcarouterApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${orcarouterApiBase(env)}` : 'none'
}

export function getCachedOrcarouterCatalogue(env: NodeJS.ProcessEnv = process.env): OrcarouterCatalogueSnapshot | null {
  return resolveOrcarouterApiKey(env) ? cache.get(identityOf(env)) ?? null : null
}

export function orcarouterListedModel(model: string, env: NodeJS.ProcessEnv = process.env): OrcarouterLiveModel | undefined {
  return getCachedOrcarouterCatalogue(env)?.models.find(row => row.id.toLowerCase() === orcarouterWireId(model).toLowerCase())
}

export function refreshOrcarouterCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<OrcarouterCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveOrcarouterApiKey(env)
  const identity = identityOf(env)
  const cached = key ? cache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('orcarouter', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < 300_000) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const work = (async (): Promise<OrcarouterCatalogueSnapshot | null> => {
    try {
      const result = await fetchOrcarouterLiveModels({ baseUrl: orcarouterApiBase(env), key: key.key, fetchImpl: opts?.fetchImpl })
      const snapshot = { ...result, fetchedAtMs: now() }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof OrcarouterCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: OrcarouterCatalogueSnapshot = {
        models: refused ? [] : cached?.models ?? [], otherLines: cached?.otherLines ?? 0, fetchedAtMs: refused ? 0 : cached?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(), lastError: (error instanceof Error ? error.message : String(error)).split(key.key).join('[redacted]'),
      }
      cache.set(identity, snapshot)
      return snapshot
    } finally { inFlight.delete(identity); bumpCatalogueEpoch() }
  })()
  inFlight.set(identity, work)
  return work
}

type CatalogueSource = { kind: 'live'; count: number; otherLines: number; fetchedAtMs: number } | { kind: 'pins' } | { kind: 'unread' }
export function orcarouterCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: { id: string; displayName: string; observedAt: string; contextWindow?: number; listedLive: boolean }[]; source: CatalogueSource } {
  const snapshot = getCachedOrcarouterCatalogue(env)
  if (!snapshot) return { rows: [], source: { kind: 'unread' } }
  if (!snapshot.models.length && snapshot.lastError && !snapshot.lastError.includes('refused the credential')) {
    return { rows: ORCAROUTER_DISPLAY_PINS.map(pin => ({ ...pin, id: orcarouterQualifiedId(pin.id), observedAt: ORCAROUTER_OBSERVED_AT, listedLive: false })), source: { kind: 'pins' } }
  }
  if (!snapshot.fetchedAtMs) return { rows: [], source: { kind: 'unread' } }
  const rows = snapshot.models.map(model => ({ id: orcarouterQualifiedId(model.id), displayName: model.displayName, observedAt: new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10), contextWindow: model.contextWindow, listedLive: true }))
  return { rows, source: { kind: 'live', count: rows.length, otherLines: snapshot.otherLines, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function orcarouterCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedOrcarouterCatalogue(env)
  const { source } = orcarouterCatalogueRows(env)
  if (source.kind === 'pins') return `pinned list — ${snapshot?.lastError}`
  if (snapshot?.lastError) return snapshot.lastError
  return source.kind === 'live' ? `${source.count} text models live` : undefined
}
