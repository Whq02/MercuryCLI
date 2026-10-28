import axios, { type AxiosResponse } from 'axios'
import { AsyncLocalStorage } from 'node:async_hooks'
import { LRUCache } from 'lru-cache'
import { AbortError } from '../../utils/errors.js'
import { webUserAgent } from '../../utils/webUserAgent.js'
import { makeOwnerKey, parseOwnerKey, type OwnerKey } from '../../services/run/ownerKey.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { OwnerScopedStore } from '../../services/run/ownerScopedStore.js'
import { registerOwnerScopedStore } from '../../services/run/ownerLifecycle.js'
import { EgressBlockedError, FetchRefusedError, networkFailureClass } from './fetchErrors.js'
import { FetchPacing } from './fetchPacing.js'
import { PAYWALL_MESSAGE } from './pageAccess.js'
import { isPrivateReaderHost, PRIVATE_ADDRESS_RULE, metadataSafeAddresses } from './privateHost.js'
import { robotsAllows } from './robots.js'

export type RedirectResult = { type: 'redirect'; originalUrl: string; redirectUrl: string; statusCode: number }
export type RawResponse = { url: string; status: number; statusText: string; headers: Record<string, unknown>; data: ArrayBuffer }
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const robotsCache = new LRUCache<string, string>({ max: 128, ttl: 15 * 60_000, ttlAutopurge: true })
const fetchOwner = new AsyncLocalStorage<OwnerKey>()
const sessions = new OwnerScopedStore<Map<string, FetchPacing>>({ name: 'webfetch-host-pacing', live: true, create: () => new Map(), dispose: sites => sites.clear() })
registerOwnerScopedStore(sessions)

export function withFetchSession<T>(owner: OwnerKey, work: () => Promise<T>): Promise<T> {
  const identity = parseOwnerKey(owner)
  return fetchOwner.run(makeOwnerKey({ workspace: identity.workspace, sessionId: identity.sessionId, lane: 'main' }), work)
}

function sitePacing(url: string): FetchPacing {
  const sites = sessions.get(fetchOwner.getStore() ?? processMainOwner())
  const key = new URL(url).hostname.toLowerCase()
  let pace = sites.get(key)
  if (!pace) { pace = new FetchPacing(); sites.set(key, pace) }
  return pace
}

function readerDecision(url: string): string {
  return isPrivateReaderHost(new URL(url).hostname)
    ? `Hosted reader not attempted: ${PRIVATE_ADDRESS_RULE.toLowerCase()}.`
    : 'Hosted reader not attempted: it renders sparse successful HTML, not network failures or site refusals.'
}

function cooling(url: string, wait: number): FetchRefusedError {
  return new FetchRefusedError(429, `This site is cooling down for ${Math.ceil(wait / 1000)}s, shared by agents in this session; no request was sent. ${readerDecision(url)} Search for another source and do not retry before the wait ends.`)
}

export function permittedFetchRedirect(from: string, to: string): boolean {
  try {
    const a = new URL(from), b = new URL(to)
    return a.protocol === b.protocol && a.port === b.port && !b.username && !b.password && a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '')
  } catch { return false }
}

async function checkRobots(url: string, signal: AbortSignal): Promise<void> {
  const origin = new URL(url).origin
  let rules = robotsCache.get(origin)
  if (rules === undefined) {
    let response: RawResponse | RedirectResult
    try { response = await fetchPage(`${origin}/robots.txt`, signal, true) } catch (error) {
      if (!(error instanceof FetchRefusedError)) throw error
      throw new FetchRefusedError(error.code, `${error.message} Mercury cannot verify robots.txt, so the page was not fetched.`)
    }
    if ('type' in response) throw new FetchRefusedError(response.statusCode, `robots.txt redirects to another host; Mercury cannot verify robots.txt, so the page was not fetched. ${readerDecision(url)}`)
    if (response.status === 404 || response.status === 410) rules = ''
    else {
      rules = Buffer.from(response.data).toString('utf8')
      if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(rules)) throw new FetchRefusedError(503, `robots.txt returned a web page instead of rules; Mercury cannot verify robots.txt, so the page was not fetched. ${readerDecision(url)}`)
    }
    robotsCache.set(origin, rules)
  }
  if (!robotsAllows(rules, url)) throw new FetchRefusedError(403, 'robots.txt disallows this path for Mercury; the page was not fetched. Hosted reader not attempted: the path is disallowed. This tool has no geocoding or routing road. Search for another source; do not retry this URL.')
}

export async function fetchPage(url: string, signal: AbortSignal, robots = false, depth = 0): Promise<RawResponse | RedirectResult> {
  if (signal.aborted) throw new AbortError()
  if (depth > 10) throw new FetchRefusedError(508, `This page redirects too many times. ${readerDecision(url)} Search for another source.`)
  const pace = sitePacing(url)
  if (pace.remaining() > 0) throw cooling(url, pace.remaining())
  if (!robots && new URL(url).pathname !== '/robots.txt') await checkRobots(url, signal)
  const response = await pace.run(0, signal, async wait => {
    if (wait > 0) throw cooling(url, wait)
    let response: AxiosResponse<ArrayBuffer>
    try {
      const addresses = await metadataSafeAddresses(url)
      response = await axios.get<ArrayBuffer>(url, {
        signal,
        lookup: async () => [addresses],
        timeout: 60_000,
        maxRedirects: 0,
        responseType: 'arraybuffer',
        maxContentLength: robots ? 512 * 1024 : 10 * 1024 * 1024,
        headers: { Accept: robots ? 'text/plain' : 'text/markdown, text/html, */*', 'User-Agent': webUserAgent() },
      })
    } catch (error) {
      if (signal.aborted) throw new AbortError()
      if (error instanceof FetchRefusedError && error.code !== 0) throw error
      if (!axios.isAxiosError(error) || !error.response) {
        const delay = pace.refuse(undefined)
        const cause = error instanceof FetchRefusedError ? error.message : networkFailureClass(error)
        throw new FetchRefusedError(0, `The ${robots ? 'robots rules' : 'page'} could not be fetched: ${cause}. ${readerDecision(url)} Backed off this host for ${Math.ceil(delay / 1000)}s across agents in this session; do not retry before the wait ends.`)
      }
      response = error.response as AxiosResponse<ArrayBuffer>
    }
    const status = response.status
    if (status === 403 && response.headers['x-proxy-error'] === 'blocked-by-allowlist') throw new EgressBlockedError(new URL(url).hostname)
    if (status === 402) throw new FetchRefusedError(status, `HTTP 402. ${PAYWALL_MESSAGE} ${readerDecision(url)}`)
    if (status === 403 || status === 406 || status === 429 || status >= 500) {
      const delay = pace.refuse(response.headers['retry-after'])
      throw new FetchRefusedError(status, `HTTP ${status}: this site ${status === 403 || status === 406 ? 'refused the request' : status === 429 ? 'is rate-limiting requests' : 'returned a server error'}; backed off for ${Math.ceil(delay / 1000)}s across agents in this session. ${readerDecision(url)} Search for another source and do not retry before the wait ends.`)
    }
    if ((status < 200 || status >= 300) && !REDIRECT_STATUSES.has(status) && !(robots && (status === 404 || status === 410))) {
      throw new FetchRefusedError(status, `The site could not serve this page (HTTP ${status}${status === 401 ? ', sign-in required' : ''}). ${readerDecision(url)} Search for another source; do not retry this URL.`)
    }
    pace.answered()
    return response
  })
  const status = response.status
  if (REDIRECT_STATUSES.has(status)) {
    const location = response.headers.location
    if (typeof location !== 'string' || !location) throw new FetchRefusedError(status, `The site redirected without a destination. ${readerDecision(url)} Search for another source.`)
    let target: string
    try { target = new URL(location, url).toString() } catch { throw new FetchRefusedError(status, `The site returned an invalid redirect destination. ${readerDecision(url)} Search for another source.`) }
    await metadataSafeAddresses(target)
    if (!permittedFetchRedirect(url, target)) return { type: 'redirect', originalUrl: url, redirectUrl: target, statusCode: status }
    return fetchPage(target, signal, robots, depth + 1)
  }
  return { url, status, statusText: response.statusText, headers: response.headers as Record<string, unknown>, data: response.data }
}
