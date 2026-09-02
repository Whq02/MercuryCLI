// ============================================================================
//  services/search/brave — the Brave Search API, the first KEYED door.
//
//  GET https://api.search.brave.com/res/v1/web/search?q=… with the key in
//  X-Subscription-Token (the documented header). The key resolves like an
//  engine key — env BRAVE_API_KEY WINS over the auth-scoped secret store
//  (utils/router/providerSecrets) — and the VALUE never enters records,
//  logs, errors, or results: presence and source only.
//
//  The response decode is TOTAL and exact over the documented shape
//  (WebSearchApiResponse: `web.results[]` of {title, url, description}); a
//  body outside that shape is the typed parse-failed outcome, never a
//  guessed hit. Brave decorates descriptions with <strong> markup unless
//  text_decorations=0 is asked — asked here, and stripped anyway.
// ============================================================================
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { readStoredBraveSearchApiKey } from '../../utils/router/providerSecrets.js'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import { htmlToText } from './htmlText.js'
import {
  DEFAULT_MAX_RESULTS,
  filterHitsByDomain,
  normaliseHits,
  searchFailure,
  searchUserAgent,
  type SearchBackend,
  type SearchHit,
  type SearchOutcome,
  type SearchRequest,
} from './searchContract.js'

const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'
const REQUEST_TIMEOUT_MS = 15_000
/** The API's documented ceiling per request. */
const BRAVE_MAX_COUNT = 20

/** Proof seam (a loopback fixture stands in for the API). */
export function braveSearchUrl(): string {
  return flagEnv('MERCURY_SEARCH_BRAVE_URL')?.trim() || BRAVE_WEB_SEARCH_URL
}

export type SearchKeySource = 'env' | 'stored'

/** The ONE Brave key resolution: env BRAVE_API_KEY WINS over the store.
 *  The value never leaves this resolver's callers' request headers. */
export function resolveBraveSearchApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: SearchKeySource } | undefined {
  const envKey = env.BRAVE_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredBraveSearchApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export type BraveDecode = { kind: 'results'; hits: SearchHit[] } | { kind: 'unrecognised'; reason: string }

/** Decode one web-search response body — exact documented field names. */
export function decodeBraveWebSearch(body: unknown): BraveDecode {
  if (typeof body !== 'object' || body === null) return { kind: 'unrecognised', reason: 'the body is not a JSON object' }
  const o = body as Record<string, unknown>
  const web = typeof o.web === 'object' && o.web !== null ? (o.web as Record<string, unknown>) : undefined
  const results = Array.isArray(web?.results) ? web.results : undefined
  if (results === undefined) {
    // A query with no web hits answers the envelope without `web` — an
    // honest empty; anything else is a shape this decoder has never seen.
    if (o.type === 'search' && web === undefined) return { kind: 'results', hits: [] }
    return { kind: 'unrecognised', reason: 'no web.results array in the body' }
  }
  const hits: SearchHit[] = []
  for (const raw of results) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    if (typeof r.url !== 'string' || typeof r.title !== 'string') continue
    hits.push({
      title: htmlToText(r.title),
      url: r.url,
      ...(typeof r.description === 'string' && r.description.trim() !== '' ? { snippet: htmlToText(r.description) } : {}),
    })
  }
  return { kind: 'results', hits }
}

/** `site:` / `-site:` operators ride the query the way the keyless door
 *  sends them (Brave honours both); the post-filter remains the law. */
export function braveQueryFor(request: SearchRequest): string {
  const parts = [request.query.trim()]
  const allowed = (request.allowedDomains ?? []).filter(d => d.trim() !== '')
  if (allowed.length === 1) parts.push(`site:${allowed[0]!.trim()}`)
  for (const domain of (request.blockedDomains ?? []).filter(d => d.trim() !== '').slice(0, 5)) {
    parts.push(`-site:${domain.trim()}`)
  }
  return parts.join(' ')
}

export interface KeyedSearchIo {
  fetchImpl?: typeof fetch
  env?: Record<string, string | undefined>
}

export async function braveSearch(request: SearchRequest, io: KeyedSearchIo = {}): Promise<SearchOutcome> {
  const key = resolveBraveSearchApiKey(io.env ?? process.env)
  if (!key) return searchFailure('no-backend', 'brave', 'no Brave Search key (BRAVE_API_KEY or /router key brave)')
  const fetchImpl = io.fetchImpl ?? getApiFetch()
  const proxyOptions = io.fetchImpl ? {} : getProxyFetchOptions()
  const url = new URL(braveSearchUrl())
  url.searchParams.set('q', braveQueryFor(request))
  url.searchParams.set('count', String(Math.min(BRAVE_MAX_COUNT, Math.max(1, request.maxResults ?? DEFAULT_MAX_RESULTS))))
  url.searchParams.set('text_decorations', '0')
  url.searchParams.set('safesearch', 'moderate')
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'Brave Search', REQUEST_TIMEOUT_MS, url, {
      ...proxyOptions,
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
        'user-agent': searchUserAgent(),
        'x-subscription-token': key.key,
      },
      ...(request.signal ? { signal: request.signal } : {}),
    } as RequestInit)
  } catch (error) {
    if (request.signal?.aborted) return searchFailure('aborted', 'brave', 'cancelled')
    return searchFailure('network', 'brave', error instanceof Error ? error.message : String(error))
  }
  if (response.status === 401 || response.status === 403) {
    return searchFailure('key-refused', 'brave', `HTTP ${response.status} — check the key at api-dashboard.search.brave.com, then /router key brave again`)
  }
  if (response.status === 429) {
    return searchFailure('rate-limited', 'brave', 'HTTP 429 — the plan\'s rate or monthly quota is spent')
  }
  if (response.status >= 500) return searchFailure('network', 'brave', `HTTP ${response.status}`)
  if (response.status !== 200) return searchFailure('provider-refused', 'brave', `HTTP ${response.status}`)
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    return searchFailure('parse-failed', 'brave', `the body is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const decoded = decodeBraveWebSearch(body)
  if (decoded.kind === 'unrecognised') return searchFailure('parse-failed', 'brave', decoded.reason)
  return {
    ok: true,
    via: 'brave',
    tier: 'keyed',
    hits: normaliseHits(filterHitsByDomain(decoded.hits, request.allowedDomains, request.blockedDomains), request.maxResults ?? DEFAULT_MAX_RESULTS),
  }
}

export const braveBackend: SearchBackend = {
  id: 'brave',
  tier: 'keyed',
  search: request => braveSearch(request),
}
