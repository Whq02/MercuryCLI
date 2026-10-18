import axios, { type AxiosResponse } from 'axios'
import { LRUCache } from 'lru-cache'
import { AbortError } from '../../utils/errors.js'
import { webUserAgent } from '../../utils/webUserAgent.js'
import { EgressBlockedError, FetchRefusedError } from './fetchErrors.js'
import { FetchPacing } from './fetchPacing.js'
import { PAYWALL_MESSAGE } from './pageAccess.js'
import { isPrivateReaderHost, PRIVATE_ADDRESS_RULE, metadataSafeAddresses } from './privateHost.js'
import { robotsAllows } from './robots.js'

export type RedirectResult = { type: 'redirect'; originalUrl: string; redirectUrl: string; statusCode: number }
export type RawResponse = { url: string; status: number; statusText: string; headers: Record<string, unknown>; data: ArrayBuffer }
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const robotsCache = new LRUCache<string, string>({ max: 128, ttl: 15 * 60_000, ttlAutopurge: true })
const sites = new Map<string, FetchPacing>()

function sitePacing(url: string): FetchPacing {
  const key = new URL(url).origin
  let pace = sites.get(key)
  if (!pace) { pace = new FetchPacing(); sites.set(key, pace) }
  return pace
}

export function permittedFetchRedirect(from: string, to: string): boolean {
  try {
    const a = new URL(from), b = new URL(to)
    return a.protocol === b.protocol && a.port === b.port && !b.username && !b.password && a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '')
  } catch { return false }
}

async function checkRobots(url: string, signal: AbortSignal): Promise<void> {
  const target = new URL(url)
  const origin = target.origin
  let rules = robotsCache.get(origin)
  if (rules === undefined) {
    const response = await fetchPage(`${origin}/robots.txt`, signal, true)
    if ('type' in response) throw new FetchRefusedError(response.statusCode, 'robots.txt redirects to another host; the page was not fetched. Search for another source.')
    if (response.status === 404 || response.status === 410) rules = ''
    else {
      rules = Buffer.from(response.data).toString('utf8')
      if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(rules)) throw new FetchRefusedError(503, 'robots.txt returned a web page instead of rules; the page was not fetched. Search for another source.')
    }
    robotsCache.set(origin, rules)
  }
  if (!robotsAllows(rules, url)) throw new FetchRefusedError(403, 'robots.txt disallows this path for Mercury; the page was not fetched or sent to a hosted reader. Search for another source — do not retry this URL.')
}

export async function fetchPage(url: string, signal: AbortSignal, robots = false, depth = 0): Promise<RawResponse | RedirectResult> {
  if (signal.aborted) throw new AbortError()
  if (depth > 10) throw new FetchRefusedError(508, 'This page redirects too many times; search for another source.')
  await metadataSafeAddresses(url)
  const pace = sitePacing(url)
  const wait = pace.remaining()
  if (wait > 0) throw new FetchRefusedError(429, `This site is cooling down for ${Math.ceil(wait / 1000)}s; no request was sent. Search for another source and do not retry before the wait ends.`)
  if (!robots && new URL(url).pathname !== '/robots.txt') await checkRobots(url, signal)
  let response: AxiosResponse<ArrayBuffer>
  try {
    response = await axios.get<ArrayBuffer>(url, {
      signal,
      lookup: async (hostname: string) => [await metadataSafeAddresses('http://' + (hostname.includes(':') ? '[' + hostname + ']' : hostname))],
      timeout: 60_000,
      maxRedirects: 0,
      responseType: 'arraybuffer',
      maxContentLength: robots ? 512 * 1024 : 10 * 1024 * 1024,
      headers: { Accept: robots ? 'text/plain' : 'text/markdown, text/html, */*', 'User-Agent': webUserAgent() },
    })
  } catch (error) {
    if (signal.aborted) throw new AbortError()
    if (!axios.isAxiosError(error) || !error.response) {
      const what = robots ? 'robots rules' : 'page'
      throw new FetchRefusedError(0, isPrivateReaderHost(new URL(url).hostname)
        ? `${PRIVATE_ADDRESS_RULE}; the ${what} could not be fetched. Search for another source.`
        : `The ${what} could not be fetched; no hosted-reader bypass was attempted. Search for another source.`)
    }
    response = error.response as AxiosResponse<ArrayBuffer>
  }
  const status = response.status
  if (status === 403 && response.headers['x-proxy-error'] === 'blocked-by-allowlist') throw new EgressBlockedError(new URL(url).hostname)
  if (REDIRECT_STATUSES.has(status)) {
    const location = response.headers.location
    if (typeof location !== 'string' || !location) throw new FetchRefusedError(status, 'The site redirected without a destination; search for another source.')
    let target: string
    try { target = new URL(location, url).toString() } catch { throw new FetchRefusedError(status, 'The site returned an invalid redirect destination; search for another source.') }
    await metadataSafeAddresses(target)
    if (!permittedFetchRedirect(url, target)) return { type: 'redirect', originalUrl: url, redirectUrl: target, statusCode: status }
    return fetchPage(target, signal, robots, depth + 1)
  }
  if (status === 402) throw new FetchRefusedError(status, PAYWALL_MESSAGE)
  if (status === 403 || status === 429 || status === 503) {
    const delay = pace.refuse(response.headers['retry-after'])
    throw new FetchRefusedError(status, `This site ${status === 403 ? 'blocked the request' : 'is rate-limiting requests'}; backed off for ${Math.ceil(delay / 1000)}s. Search for another source and do not retry before the wait ends.`)
  }
  if (status < 200 || status >= 300) {
    if (!(robots && (status === 404 || status === 410))) throw new FetchRefusedError(status, `The site could not serve this page (${status}${status === 401 ? ', sign-in required' : ''}); search for another source — do not retry this URL.`)
  }
  if (pace.remaining() === 0) pace.answered()
  return { url, status, statusText: response.statusText, headers: response.headers as Record<string, unknown>, data: response.data }
}
