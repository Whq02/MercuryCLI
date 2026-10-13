import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import { htmlToText } from './htmlText.js'
import { DEFAULT_MAX_RESULTS, filterHitsByDomain, normaliseHits, searchBackendLabel, searchFailure, searchUserAgent, type SearchHit, type SearchOutcome, type SearchRequest } from './searchContract.js'
import { cachedAnswerNote, liveSearchClock, noteAnswered, noteRateLimited, rememberSearch, reserveSearchAttempt, secondsLeftLabel, serverSearchWaitMs, takeCachedSearch, withSearchTurn, type SearchClock } from './searchPacing.js'
import { SEARCH_SOURCE_POLICIES, type OfficialSearchSource } from './searchSources.js'

const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''

export function officialSearchUrl(source: OfficialSearchSource, words: string, count = DEFAULT_MAX_RESULTS): URL {
  const n = String(Math.min(DEFAULT_MAX_RESULTS, Math.max(1, count)))
  const endpoints: Record<OfficialSearchSource, [string, Record<string, string>]> = {
    stackexchange: ['https://api.stackexchange.com/2.3/search/advanced', { site: 'stackoverflow', q: words, sort: 'relevance', order: 'desc', pagesize: n }],
    npm: ['https://registry.npmjs.org/-/v1/search', { text: words, size: n }],
    pypi: [`https://pypi.org/pypi/${encodeURIComponent(words)}/json`, {}],
    crates: ['https://crates.io/api/v1/crates', { q: words, per_page: n }],
    github: ['https://api.github.com/search/code', { q: `${words} is:public`, per_page: n }],
    hackernews: ['https://hn.algolia.com/api/v1/search', { query: words, tags: 'story', hitsPerPage: n }],
    wikipedia: ['https://en.wikipedia.org/w/api.php', { action: 'query', list: 'search', srsearch: words, srlimit: n, format: 'json', utf8: '1', maxlag: '5' }],
  }
  const [endpoint, params] = endpoints[source]
  const url = new URL(endpoint)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url
}

export function decodeOfficialSearch(source: OfficialSearchSource, body: unknown): SearchHit[] | undefined {
  const o = object(body)
  const rows = source === 'stackexchange' || source === 'github' ? o.items
    : source === 'npm' ? o.objects : source === 'pypi' ? (typeof object(o.info).name === 'string' ? [o.info] : undefined)
      : source === 'crates' ? o.crates : source === 'hackernews' ? o.hits : object(o.query).search
  if (!Array.isArray(rows)) return undefined
  const hits: SearchHit[] = []
  for (const raw of rows) {
    const r = source === 'npm' ? object(object(raw).package) : object(raw)
    if (source === 'github' && object(r.repository).private !== false) continue
    const title = text(r.title) || text(r.name) || text(r.id)
    const url = source === 'stackexchange' ? text(r.link)
      : source === 'npm' ? text(object(r.links).npm)
        : source === 'pypi' ? text(r.package_url)
          : source === 'crates' ? (text(r.id) ? `https://crates.io/crates/${encodeURIComponent(text(r.id))}` : '')
            : source === 'github' ? text(r.html_url)
              : source === 'hackernews' ? (text(r.objectID) ? `https://news.ycombinator.com/item?id=${encodeURIComponent(text(r.objectID))}` : '')
                : title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` : ''
    if (!title || !url) continue
    const snippet = source === 'stackexchange' ? '' : source === 'pypi' ? text(r.summary)
      : source === 'github' ? text(r.path) : source === 'hackernews' ? text(r.story_text) : text(r.snippet) || text(r.description)
    hits.push({ title: htmlToText(title), url, snippet: htmlToText(snippet), source_type: source })
  }
  return normaliseHits(hits)
}

export interface OfficialSearchIo {
  fetchImpl?: typeof fetch
  clock?: SearchClock
  env?: Record<string, string | undefined>
}

export async function officialSearch(source: OfficialSearchSource, words: string, request: SearchRequest, io: OfficialSearchIo = {}): Promise<SearchOutcome> {
  const clock = io.clock ?? liveSearchClock
  const token = source === 'github' ? (io.env ?? process.env).GH_TOKEN?.trim() : undefined
  if (request.signal?.aborted) return searchFailure('aborted', source, 'cancelled')
  if (source === 'github' && !token) return searchFailure('no-backend', source, 'GitHub code search requires a token (GH_TOKEN); unauthenticated code search was not attempted')
  const scoped = { ...request, query: words, cacheScope: `official:${source}` }
  const cached = source !== 'github' ? takeCachedSearch(scoped, clock.now()) : undefined
  if (cached) return { ok: true, via: source, tier: 'keyless', hits: cached.hits, notes: [SEARCH_SOURCE_POLICIES[source].terms, cachedAnswerNote(searchBackendLabel(source))] }
  return withSearchTurn(source, SEARCH_SOURCE_POLICIES[source], clock, request.signal, async waitMs => {
    if (request.signal?.aborted) return searchFailure('aborted', source, 'cancelled')
    if (waitMs > 0) return searchFailure('rate-limited', source, `wait ${secondsLeftLabel(waitMs)} before trying this source again; no request made`)
    const fresh = source !== 'github' ? takeCachedSearch(scoped, clock.now()) : undefined
    if (fresh) return { ok: true, via: source, tier: 'keyless', hits: fresh.hits, notes: [SEARCH_SOURCE_POLICIES[source].terms, cachedAnswerNote(searchBackendLabel(source))] }
    const duplicateWait = source === 'stackexchange' ? reserveSearchAttempt(source, words, clock.now(), 60_000) : 0
    if (duplicateWait > 0) return searchFailure('rate-limited', source, `the same query was just attempted; wait ${secondsLeftLabel(duplicateWait)} before requesting it again`)
    let response: Response
    try {
      response = await fetchWithProviderDeadline(io.fetchImpl ?? getApiFetch(), searchBackendLabel(source), 15_000, officialSearchUrl(source, words, request.maxResults), {
        ...(io.fetchImpl ? {} : getProxyFetchOptions()),
        redirect: 'error',
        headers: { accept: 'application/json', 'user-agent': searchUserAgent(), ...(token ? { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' } : {}) },
        ...(request.signal ? { signal: request.signal } : {}),
      })
    } catch {
      return searchFailure(request.signal?.aborted ? 'aborted' : 'network', source, request.signal?.aborted ? 'cancelled' : 'the request did not complete; try another source')
    }
    const serverWait = serverSearchWaitMs(response.headers, clock.now())
    if (response.status === 429 || response.status === 403 || response.status === 503) {
      const wait = noteRateLimited(source, clock, Math.max(serverWait, source === 'github' ? 60_000 : 0))
      await response.body?.cancel()
      return searchFailure('rate-limited', source, `the source refused this request; wait ${secondsLeftLabel(wait)} before trying it again`)
    }
    if (response.status === 401) {
      await response.body?.cancel()
      return searchFailure('key-refused', source, 'the source requires valid authentication; no retry was made')
    }
    if (source === 'pypi' && response.status === 404) {
      await response.body?.cancel()
      rememberSearch(scoped, { via: source, tier: 'keyless', hits: [], queries: [words] }, clock.now())
      return { ok: true, via: source, tier: 'keyless', hits: [], notes: ['PyPI lists no project with that exact name.'] }
    }
    if (!response.ok) {
      await response.body?.cancel()
      return searchFailure('provider-refused', source, 'the source did not answer this search; try another source')
    }
    let body: unknown
    try { body = await response.json() } catch {
      return searchFailure(request.signal?.aborted ? 'aborted' : 'parse-failed', source, request.signal?.aborted ? 'cancelled' : 'the response was not JSON; no result was guessed')
    }
    if (request.signal?.aborted) return searchFailure('aborted', source, 'cancelled')
    const o = object(body)
    const backoff = source === 'stackexchange' && typeof o.backoff === 'number' && Number.isFinite(o.backoff) ? Math.max(0, o.backoff * 1000) : 0
    const exhausted = source === 'stackexchange' && o.quota_remaining === 0
    const apiError = object(o.error)
    if ((source === 'wikipedia' && ['maxlag', 'ratelimited'].includes(text(apiError.code))) || o.error_id === 502) {
      const wait = noteRateLimited(source, clock, Math.max(serverWait, backoff, exhausted ? 86_400_000 : 0))
      return searchFailure('rate-limited', source, `the source asked this client to wait ${secondsLeftLabel(wait)}; no retry was made`)
    }
    const delay = Math.max(backoff, serverWait, exhausted ? 86_400_000 : 0)
    if (delay > 0) noteRateLimited(source, clock, delay)
    if (o.error_id !== undefined || o.error !== undefined) return searchFailure('provider-refused', source, 'the source refused this query; try another wording or another source')
    const decoded = decodeOfficialSearch(source, body)
    if (decoded === undefined) return searchFailure('parse-failed', source, 'the documented result list was absent; no result was guessed')
    const hits = normaliseHits(filterHitsByDomain(decoded, request.allowedDomains, request.blockedDomains), request.maxResults)
    if (delay === 0) noteAnswered(source)
    if (source !== 'github') rememberSearch(scoped, { via: source, tier: 'keyless', hits, queries: [words] }, clock.now())
    return { ok: true, via: source, tier: source === 'github' ? 'keyed' : 'keyless', hits, notes: [SEARCH_SOURCE_POLICIES[source].terms] }
  })
}
