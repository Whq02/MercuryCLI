// ============================================================================
//  services/search/tavily — the Tavily Search API, the second KEYED door.
//
//  POST https://api.tavily.com/search with a JSON body and the key as a
//  Bearer token (the documented auth). The key resolves like an engine key
//  — env TAVILY_API_KEY WINS over the auth-scoped secret store — and the
//  VALUE never enters records, logs, errors, or results.
//
//  Tavily carries include_domains / exclude_domains natively, so the
//  request passes the tool's domain lists on the wire AND the contract's
//  post-filter stays the law over what comes back. The decode is TOTAL and
//  exact over the documented shape (`results[]` of {title, url, content});
//  anything else is the typed parse-failed outcome.
// ============================================================================
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { readStoredTavilyApiKey } from '../../utils/router/providerSecrets.js'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import type { KeyedSearchIo, SearchKeySource } from './brave.js'
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

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
const REQUEST_TIMEOUT_MS = 15_000
/** The API's documented ceiling per request. */
const TAVILY_MAX_RESULTS = 20

/** Proof seam (a loopback fixture stands in for the API). */
export function tavilySearchUrl(): string {
  return flagEnv('MERCURY_SEARCH_TAVILY_URL')?.trim() || TAVILY_SEARCH_URL
}

/** The ONE Tavily key resolution: env TAVILY_API_KEY WINS over the store. */
export function resolveTavilyApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: SearchKeySource } | undefined {
  const envKey = env.TAVILY_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredTavilyApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export type TavilyDecode = { kind: 'results'; hits: SearchHit[] } | { kind: 'unrecognised'; reason: string }

/** Decode one search response body — exact documented field names. */
export function decodeTavilySearch(body: unknown): TavilyDecode {
  if (typeof body !== 'object' || body === null) return { kind: 'unrecognised', reason: 'the body is not a JSON object' }
  const o = body as Record<string, unknown>
  if (!Array.isArray(o.results)) return { kind: 'unrecognised', reason: 'no results array in the body' }
  const hits: SearchHit[] = []
  for (const raw of o.results) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    if (typeof r.url !== 'string' || typeof r.title !== 'string') continue
    hits.push({
      title: r.title,
      url: r.url,
      ...(typeof r.content === 'string' && r.content.trim() !== '' ? { snippet: r.content } : {}),
    })
  }
  return { kind: 'results', hits }
}

/** The documented request body for one search. */
export function tavilyRequestBodyFor(request: SearchRequest): Record<string, unknown> {
  const allowed = (request.allowedDomains ?? []).filter(d => d.trim() !== '')
  const blocked = (request.blockedDomains ?? []).filter(d => d.trim() !== '')
  return {
    query: request.query.trim(),
    max_results: Math.min(TAVILY_MAX_RESULTS, Math.max(1, request.maxResults ?? DEFAULT_MAX_RESULTS)),
    search_depth: 'basic',
    include_answer: false,
    include_raw_content: false,
    ...(allowed.length > 0 ? { include_domains: allowed } : {}),
    ...(blocked.length > 0 ? { exclude_domains: blocked } : {}),
  }
}

export async function tavilySearch(request: SearchRequest, io: KeyedSearchIo = {}): Promise<SearchOutcome> {
  const key = resolveTavilyApiKey(io.env ?? process.env)
  if (!key) return searchFailure('no-backend', 'tavily', 'no Tavily key (TAVILY_API_KEY or /router key tavily)')
  const fetchImpl = io.fetchImpl ?? getApiFetch()
  const proxyOptions = io.fetchImpl ? {} : getProxyFetchOptions()
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'Tavily', REQUEST_TIMEOUT_MS, tavilySearchUrl(), {
      ...proxyOptions,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': searchUserAgent(),
        authorization: `Bearer ${key.key}`,
      },
      body: JSON.stringify(tavilyRequestBodyFor(request)),
      ...(request.signal ? { signal: request.signal } : {}),
    } as RequestInit)
  } catch (error) {
    if (request.signal?.aborted) return searchFailure('aborted', 'tavily', 'cancelled')
    return searchFailure('network', 'tavily', error instanceof Error ? error.message : String(error))
  }
  if (response.status === 401 || response.status === 403) {
    return searchFailure('key-refused', 'tavily', `HTTP ${response.status} — check the key at app.tavily.com, then /router key tavily again`)
  }
  // 429 is the rate limit; 432/433 are Tavily's plan-limit statuses.
  if (response.status === 429 || response.status === 432 || response.status === 433) {
    return searchFailure('rate-limited', 'tavily', `HTTP ${response.status} — the plan's rate or monthly credits are spent`)
  }
  if (response.status >= 500) return searchFailure('network', 'tavily', `HTTP ${response.status}`)
  if (response.status !== 200) return searchFailure('provider-refused', 'tavily', `HTTP ${response.status}`)
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    return searchFailure('parse-failed', 'tavily', `the body is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const decoded = decodeTavilySearch(body)
  if (decoded.kind === 'unrecognised') return searchFailure('parse-failed', 'tavily', decoded.reason)
  return {
    ok: true,
    via: 'tavily',
    tier: 'keyed',
    hits: normaliseHits(filterHitsByDomain(decoded.hits, request.allowedDomains, request.blockedDomains), request.maxResults ?? DEFAULT_MAX_RESULTS),
  }
}

export const tavilyBackend: SearchBackend = {
  id: 'tavily',
  tier: 'keyed',
  search: request => tavilySearch(request),
}
