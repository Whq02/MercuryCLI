import { flagEnv } from '../../substrate/flagRegistry.js'
import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { readStoredBraveSearchApiKey } from '../providers/providerSecrets.js'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import { htmlToText } from './htmlText.js'
import { liveSearchClock, noteRateLimited, secondsLeftLabel, serverSearchWaitMs, withSearchTurn, type SearchClock } from './searchPacing.js'
import {
  DEFAULT_MAX_RESULTS,
  filterHitsByDomain,
  normaliseHits,
  searchFailure,
  searchUserAgent,
  type SearchHit,
  type SearchOutcome,
  type SearchRequest,
} from './searchContract.js'

const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'
const REQUEST_TIMEOUT_MS = 15_000
const BRAVE_MAX_COUNT = 20

function braveSearchUrl(): string {
  return flagEnv('MERCURY_SEARCH_BRAVE_URL')?.trim() || BRAVE_WEB_SEARCH_URL
}

export type SearchKeySource = 'env' | 'stored'

export function resolveBraveSearchApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: SearchKeySource } | undefined {
  const envKey = env.BRAVE_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredBraveSearchApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

type BraveDecode = { kind: 'results'; hits: SearchHit[] } | { kind: 'unrecognised'; reason: string }

export function decodeBraveWebSearch(body: unknown): BraveDecode {
  if (typeof body !== 'object' || body === null) return { kind: 'unrecognised', reason: 'the body is not a JSON object' }
  const o = body as Record<string, unknown>
  const web = typeof o.web === 'object' && o.web !== null ? (o.web as Record<string, unknown>) : undefined
  const results = Array.isArray(web?.results) ? web.results : undefined
  if (results === undefined) {
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
      snippet: typeof r.description === 'string' ? htmlToText(r.description) : '',
      source_type: 'brave',
    })
  }
  return { kind: 'results', hits }
}

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
  clock?: SearchClock
}

const BRAVE_PACING = { intervalMs: 1000, why: 'https://api-dashboard.search.brave.com/documentation/guides/rate-limiting — plan-specific one-second sliding windows and parallel quota headers. Client courtesy: one request/second; exhausted-window resets are seconds, not timestamps.' }

export async function braveSearch(request: SearchRequest, io: KeyedSearchIo = {}): Promise<SearchOutcome> {
  return withSearchTurn('brave', BRAVE_PACING, io.clock ?? liveSearchClock, request.signal, async wait => {
    if (request.signal?.aborted) return searchFailure('aborted', 'brave', 'cancelled')
    if (wait > 0) return searchFailure('rate-limited', 'brave', `wait ${secondsLeftLabel(wait)}; no request made`)
    return requestBraveSearch(request, io)
  })
}

async function requestBraveSearch(request: SearchRequest, io: KeyedSearchIo): Promise<SearchOutcome> {
  const key = resolveBraveSearchApiKey(io.env ?? process.env)
  if (!key) return searchFailure('no-backend', 'brave', 'no Brave Search key (set BRAVE_API_KEY)')
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
  const clock = io.clock ?? liveSearchClock
  const remaining = (response.headers.get('x-ratelimit-remaining') ?? '').split(',').map(s => s.trim())
  const resets = (response.headers.get('x-ratelimit-reset') ?? '').split(',').map(Number)
  const resetWait = Math.max(0, ...remaining.map((left, i) => left === '0' && Number.isFinite(resets[i]) ? Math.max(0, resets[i]! * 1000) : 0))
  const wait = Math.max(resetWait, serverSearchWaitMs(new Headers({ 'retry-after': response.headers.get('retry-after') ?? '0' }), clock.now()))
  if (wait > 0 || response.status === 429) noteRateLimited('brave', clock, wait)
  if (response.status === 401 || response.status === 403) {
    return searchFailure('key-refused', 'brave', `HTTP ${response.status} — check the key at api-dashboard.search.brave.com and set BRAVE_API_KEY again`)
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
