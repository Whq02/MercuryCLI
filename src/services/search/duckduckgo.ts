import { flagEnv } from '../../substrate/flagRegistry.js'
import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import { htmlToText, readAttribute } from './htmlText.js'
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

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/'
const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/'
const REQUEST_TIMEOUT_MS = 12_000

export function duckduckgoHtmlUrl(): string {
  return flagEnv('MERCURY_SEARCH_DDG_HTML_URL')?.trim() || DDG_HTML_URL
}
export function duckduckgoLiteUrl(): string {
  return flagEnv('MERCURY_SEARCH_DDG_LITE_URL')?.trim() || DDG_LITE_URL
}


export type DuckDuckGoPage =
  | { kind: 'results'; hits: SearchHit[] }
  | { kind: 'challenge' }
  | { kind: 'unrecognised'; reason: string }

const CHALLENGE_RE = /anomaly-modal|id="challenge-form"|bots use DuckDuckGo too/i
const HTML_FRAME_RE = /id="links"|class="serp__results"|class="no-results"|class="header__form"/
const LITE_FRAME_RE = /action=["']\/lite\/["']|class=['"]result-link['"]|No (?:more )?results/

export function resolveDuckDuckGoHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  const absolute = href.startsWith('//') ? `https:${href}` : href.startsWith('/') ? `https://duckduckgo.com${href}` : href
  let parsed: URL
  try {
    parsed = new URL(absolute)
  } catch {
    return undefined
  }
  if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname)) {
    if (parsed.pathname === '/l/' || parsed.pathname === '/l') {
      const target = parsed.searchParams.get('uddg')
      return target && /^https?:\/\//i.test(target) ? target : undefined
    }
    return undefined
  }
  return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : undefined
}

export function parseDuckDuckGoHtml(html: string): DuckDuckGoPage {
  if (CHALLENGE_RE.test(html)) return { kind: 'challenge' }
  const blockStarts: Array<{ at: number; ad: boolean }> = []
  const blockRe = /<div\s+class="(result\s[^"]*)"/g
  for (let match = blockRe.exec(html); match !== null; match = blockRe.exec(html)) {
    blockStarts.push({ at: match.index, ad: /\bresult--ad\b/.test(match[1] ?? '') })
  }
  if (blockStarts.length === 0) {
    if (HTML_FRAME_RE.test(html)) return { kind: 'results', hits: [] }
    return { kind: 'unrecognised', reason: 'no result frame and no result block on the page' }
  }
  const hits: SearchHit[] = []
  blockStarts.forEach((block, index) => {
    if (block.ad) return
    const end = blockStarts[index + 1]?.at ?? html.length
    const chunk = html.slice(block.at, end)
    const title = /<a\b([^>]*\bclass="result__a"[^>]*)>([\s\S]*?)<\/a>/.exec(chunk)
    if (!title) return
    const url = resolveDuckDuckGoHref(readAttribute(title[1] ?? '', 'href'))
    if (!url) return
    const snippet = /<(a|div|span|td)\b[^>]*\bclass="result__snippet"[^>]*>([\s\S]*?)<\/\1>/.exec(chunk)
    hits.push({
      title: htmlToText(title[2] ?? ''),
      url,
      ...(snippet ? { snippet: htmlToText(snippet[2] ?? '') } : {}),
    })
  })
  return { kind: 'results', hits }
}

export function parseDuckDuckGoLite(html: string): DuckDuckGoPage {
  if (CHALLENGE_RE.test(html)) return { kind: 'challenge' }
  const rowRe = /<a\b([^>]*\bclass=['"]result-link['"][^>]*)>([\s\S]*?)<\/a>|<td\b[^>]*\bclass=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g
  const hits: SearchHit[] = []
  let sawLink = false
  for (let match = rowRe.exec(html); match !== null; match = rowRe.exec(html)) {
    if (match[1] !== undefined) {
      sawLink = true
      const url = resolveDuckDuckGoHref(readAttribute(match[1], 'href'))
      if (!url) continue
      hits.push({ title: htmlToText(match[2] ?? ''), url })
    } else {
      const last = hits.at(-1)
      if (last && last.snippet === undefined) last.snippet = htmlToText(match[3] ?? '')
    }
  }
  if (!sawLink) {
    if (LITE_FRAME_RE.test(html)) return { kind: 'results', hits: [] }
    return { kind: 'unrecognised', reason: 'no result frame and no result row on the page' }
  }
  return { kind: 'results', hits }
}

export function keylessQueryFor(request: SearchRequest): string {
  const parts = [request.query.trim()]
  const allowed = (request.allowedDomains ?? []).filter(d => d.trim() !== '')
  if (allowed.length === 1) parts.push(`site:${allowed[0]!.trim()}`)
  for (const domain of (request.blockedDomains ?? []).filter(d => d.trim() !== '').slice(0, 5)) {
    parts.push(`-site:${domain.trim()}`)
  }
  return parts.join(' ')
}

export interface KeylessSearchIo {
  fetchImpl?: typeof fetch
}

type DoorAttempt = { ok: true; hits: SearchHit[] } | { ok: false; failure: Extract<SearchOutcome, { ok: false }> }

async function attemptDoor(
  door: 'duckduckgo' | 'duckduckgo-lite',
  url: string,
  request: SearchRequest,
  io: KeylessSearchIo,
): Promise<DoorAttempt> {
  const fetchImpl = io.fetchImpl ?? getApiFetch()
  const proxyOptions = io.fetchImpl ? {} : getProxyFetchOptions()
  const form = new URLSearchParams({ q: keylessQueryFor(request), kl: 'us-en' })
  if (door === 'duckduckgo') form.set('b', '')
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'DuckDuckGo', REQUEST_TIMEOUT_MS, url, {
      ...proxyOptions,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': searchUserAgent(),
      },
      body: form.toString(),
      ...(request.signal ? { signal: request.signal } : {}),
    } as RequestInit)
  } catch (error) {
    if (request.signal?.aborted) return { ok: false, failure: searchFailure('aborted', door, 'cancelled') }
    return { ok: false, failure: searchFailure('network', door, error instanceof Error ? error.message : String(error)) }
  }
  let body = ''
  try {
    body = await response.text()
  } catch (error) {
    return { ok: false, failure: searchFailure('network', door, `the page body could not be read (${error instanceof Error ? error.message : String(error)})`) }
  }
  const page = door === 'duckduckgo' ? parseDuckDuckGoHtml(body) : parseDuckDuckGoLite(body)
  if (page.kind === 'challenge' || response.status === 202 || response.status === 403 || response.status === 429) {
    return { ok: false, failure: searchFailure('rate-limited', door, `HTTP ${response.status}${page.kind === 'challenge' ? ' with the bot challenge page' : ''}`) }
  }
  if (response.status >= 500) {
    return { ok: false, failure: searchFailure('network', door, `HTTP ${response.status}`) }
  }
  if (page.kind === 'unrecognised') {
    return { ok: false, failure: searchFailure('parse-failed', door, `HTTP ${response.status}, ${page.reason}`) }
  }
  return { ok: true, hits: page.hits }
}

export async function keylessSearch(request: SearchRequest, io: KeylessSearchIo = {}): Promise<SearchOutcome> {
  const html = await attemptDoor('duckduckgo', duckduckgoHtmlUrl(), request, io)
  if (html.ok) {
    return {
      ok: true,
      via: 'duckduckgo',
      tier: 'keyless',
      hits: normaliseHits(filterHitsByDomain(html.hits, request.allowedDomains, request.blockedDomains), request.maxResults ?? DEFAULT_MAX_RESULTS),
    }
  }
  if (html.failure.kind === 'aborted') return html.failure
  const lite = await attemptDoor('duckduckgo-lite', duckduckgoLiteUrl(), request, io)
  if (lite.ok) {
    return {
      ok: true,
      via: 'duckduckgo-lite',
      tier: 'keyless',
      hits: normaliseHits(filterHitsByDomain(lite.hits, request.allowedDomains, request.blockedDomains), request.maxResults ?? DEFAULT_MAX_RESULTS),
    }
  }
  if (lite.failure.kind === 'aborted') return lite.failure
  return searchFailure(lite.failure.kind, 'duckduckgo-lite', `${lite.failure.message} (the html door: ${html.failure.kind} — ${html.failure.message})`)
}

export const duckduckgoBackend: SearchBackend = {
  id: 'duckduckgo',
  tier: 'keyless',
  search: request => keylessSearch(request),
}
