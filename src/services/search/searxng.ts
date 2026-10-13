import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import { htmlToText } from './htmlText.js'
import { filterHitsByDomain, normaliseHits, searchFailure, searchUserAgent, type SearchHit, type SearchOutcome, type SearchRequest } from './searchContract.js'
import { coolDownRemainingMs, liveSearchClock, noteRateLimited, secondsLeftLabel, serverSearchWaitMs, withSearchTurn, type SearchClock } from './searchPacing.js'
import { configuredSearxngInstances, SEARXNG_RATE_POLICY, type SearxngInstance } from './searxngInstances.js'

const failed = new Map<string, string>()
let cursor = 0
export function resetSearxngSession(): void { failed.clear(); cursor = 0 }
export function decodeSearxng(body: unknown): SearchHit[] | undefined {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { results?: unknown }).results)) return undefined
  const hits: SearchHit[] = []
  for (const raw of (body as { results: unknown[] }).results) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    if (typeof r.title !== 'string' || typeof r.url !== 'string') continue
    hits.push({ title: htmlToText(r.title), url: r.url, snippet: typeof r.content === 'string' ? htmlToText(r.content) : '', source_type: 'searxng' })
  }
  return hits
}
export async function searxngSearch(request: SearchRequest, io: { fetchImpl?: typeof fetch; clock?: SearchClock; instances?: readonly SearxngInstance[] } = {}): Promise<SearchOutcome> {
  const clock = io.clock ?? liveSearchClock
  const configured = io.instances ? { instances: io.instances } : configuredSearxngInstances()
  const instances = configured.instances
  if (request.signal?.aborted) return searchFailure('aborted', 'searxng', 'cancelled')
  if (configured.error) return searchFailure('no-backend', 'searxng', configured.error)
  if (!instances.length) return searchFailure('no-backend', 'searxng', 'no metasearch instance configured; MERCURY_SEARCH_SEARXNG_INSTANCES adds instances whose API-use policy you verified')
  const wait = coolDownRemainingMs('searxng', clock.now())
  if (wait > 0) return searchFailure('rate-limited', 'searxng', `wait ${secondsLeftLabel(wait)}; no instance was contacted`)
  const start = cursor++ % Math.max(1, instances.length)
  const notes: string[] = []
  for (let i = 0; i < instances.length; i++) {
    const instance = instances[(start + i) % instances.length]!
    if (!instance.apiAllowed) { notes.push(`${instance.url}: API-use policy not verified; not contacted`); continue }
    if (failed.has(instance.url)) { notes.push(`${instance.url}: ${failed.get(instance.url)}; skipped for this session`); continue }
    const outcome = await withSearchTurn('searxng', SEARXNG_RATE_POLICY, clock, request.signal, async waitMs => {
      if (request.signal?.aborted) return searchFailure('aborted', 'searxng', 'cancelled')
      if (waitMs > 0) return searchFailure('rate-limited', 'searxng', `wait ${secondsLeftLabel(waitMs)}; no instance was contacted`)
      if (failed.has(instance.url)) return searchFailure('network', 'searxng', 'instance already failed this session')
      const url = new URL('search', instance.url)
      url.searchParams.set('q', request.query)
      url.searchParams.set('format', 'json')
      let response: Response
      try {
        response = await fetchWithProviderDeadline(io.fetchImpl ?? getApiFetch(), 'SearXNG', 12_000, url, {
          ...(io.fetchImpl ? {} : getProxyFetchOptions()), redirect: 'error',
          headers: { accept: 'application/json', 'user-agent': searchUserAgent() }, ...(request.signal ? { signal: request.signal } : {}),
        })
      } catch {
        if (request.signal?.aborted) return searchFailure('aborted', 'searxng', 'cancelled')
        failed.set(instance.url, 'request did not complete')
        return searchFailure('network', 'searxng', `${instance.url}: request did not complete`)
      }
      if ([403, 429, 503].includes(response.status)) {
        const delay = noteRateLimited('searxng', clock, serverSearchWaitMs(response.headers, clock.now()))
        failed.set(instance.url, 'refused automated API access')
        await response.body?.cancel()
        return searchFailure('rate-limited', 'searxng', `${instance.url} refused this request; wait ${secondsLeftLabel(delay)}; no other instance was tried to evade the refusal`)
      }
      if (!response.ok) {
        failed.set(instance.url, 'API unavailable')
        await response.body?.cancel()
        return searchFailure('network', 'searxng', `${instance.url}: API unavailable`)
      }
      let body: unknown
      try { body = await response.json() } catch { body = null }
      if (request.signal?.aborted) return searchFailure('aborted', 'searxng', 'cancelled')
      const hits = decodeSearxng(body)
      if (hits === undefined) {
        failed.set(instance.url, 'JSON API did not answer; no HTML was scraped')
        return searchFailure('parse-failed', 'searxng', `${instance.url}: JSON API did not answer; no HTML was scraped`)
      }
      return { ok: true as const, via: 'searxng' as const, tier: 'keyless' as const, hits: normaliseHits(filterHitsByDomain(hits, request.allowedDomains, request.blockedDomains), request.maxResults), notes: [`SearXNG instance: ${instance.url}; its policy applies: ${instance.terms}`, ...notes] }
    })
    if (outcome.ok && outcome.hits.length) return outcome
    if (!outcome.ok && (outcome.kind === 'rate-limited' || outcome.kind === 'aborted')) return outcome
    notes.push(outcome.ok ? `${instance.url}: no matching results` : outcome.message)
  }
  return searchFailure('no-backend', 'searxng', notes.join('; ') || 'no metasearch instance configured')
}
