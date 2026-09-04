import { flagEnv } from '../../substrate/flagRegistry.js'
import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import { htmlToText, readAttribute } from './htmlText.js'
import {
  coolDownRemainingMs,
  liveSearchClock,
  noteAnswered,
  noteRateLimited,
  retryBackoffMs,
  secondsLeftLabel,
  type SearchClock,
} from './searchPacing.js'
import {
  DEFAULT_MAX_RESULTS,
  failureLine,
  filterHitsByDomain,
  normaliseHits,
  searchFailure,
  searchUserAgent,
  type SearchBackend,
  type SearchFailure,
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
  clock?: SearchClock
}

type KeylessDoor = 'duckduckgo' | 'duckduckgo-lite'

type DoorAttempt = { ok: true; hits: SearchHit[] } | { ok: false; failure: SearchFailure; knocked: boolean }

async function attemptDoor(
  door: KeylessDoor,
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
    if (request.signal?.aborted) return { ok: false, knocked: true, failure: searchFailure('aborted', door, 'cancelled') }
    return { ok: false, knocked: true, failure: searchFailure('network', door, error instanceof Error ? error.message : String(error)) }
  }
  let body = ''
  try {
    body = await response.text()
  } catch (error) {
    return { ok: false, knocked: true, failure: searchFailure('network', door, `the page body could not be read (${error instanceof Error ? error.message : String(error)})`) }
  }
  const page = door === 'duckduckgo' ? parseDuckDuckGoHtml(body) : parseDuckDuckGoLite(body)
  if (page.kind === 'challenge' || response.status === 202 || response.status === 403 || response.status === 429 || response.status === 503) {
    return { ok: false, knocked: true, failure: searchFailure('rate-limited', door, `HTTP ${response.status}${page.kind === 'challenge' ? ' with the bot challenge page' : ''}`) }
  }
  if (response.status >= 500) {
    return { ok: false, knocked: true, failure: searchFailure('network', door, `HTTP ${response.status}`) }
  }
  if (page.kind === 'unrecognised') {
    return { ok: false, knocked: true, failure: searchFailure('parse-failed', door, `HTTP ${response.status}, ${page.reason}`) }
  }
  return { ok: true, hits: page.hits }
}

function coolingAttempt(door: KeylessDoor, leftMs: number): DoorAttempt {
  return { ok: false, knocked: false, failure: searchFailure('rate-limited', door, `cooling down after a rate limit — ${secondsLeftLabel(leftMs)} left; not knocked`) }
}

async function openKeylessDoor(door: KeylessDoor, url: string, request: SearchRequest, io: KeylessSearchIo, clock: SearchClock): Promise<DoorAttempt> {
  const left = coolDownRemainingMs(door, clock.now())
  if (left > 0) return coolingAttempt(door, left)
  return attemptDoor(door, url, request, io)
}

function keylessAnswer(via: KeylessDoor, hits: SearchHit[], request: SearchRequest, notes: string[]): SearchOutcome {
  noteAnswered(via)
  return {
    ok: true,
    via,
    tier: 'keyless',
    hits: normaliseHits(filterHitsByDomain(hits, request.allowedDomains, request.blockedDomains), request.maxResults ?? DEFAULT_MAX_RESULTS),
    ...(notes.length > 0 ? { notes } : {}),
  }
}

function retryable(failure: SearchFailure): boolean {
  return failure.kind === 'rate-limited' || failure.kind === 'network'
}

export async function keylessSearch(request: SearchRequest, io: KeylessSearchIo = {}): Promise<SearchOutcome> {
  const clock = io.clock ?? liveSearchClock
  const html = await openKeylessDoor('duckduckgo', duckduckgoHtmlUrl(), request, io, clock)
  if (html.ok) return keylessAnswer('duckduckgo', html.hits, request, [])
  if (html.failure.kind === 'aborted') return html.failure
  const lite = await openKeylessDoor('duckduckgo-lite', duckduckgoLiteUrl(), request, io, clock)
  if (lite.ok) return keylessAnswer('duckduckgo-lite', lite.hits, request, [failureLine(html.failure)])
  if (lite.failure.kind === 'aborted') return lite.failure

  let retry: { waitedMs: number; failure: SearchFailure } | undefined
  if (html.knocked && retryable(html.failure)) {
    const waitedMs = retryBackoffMs(clock.random)
    await clock.sleep(waitedMs, request.signal)
    if (request.signal?.aborted) return searchFailure('aborted', 'duckduckgo', 'cancelled')
    const again = await attemptDoor('duckduckgo', duckduckgoHtmlUrl(), request, io)
    if (again.ok) {
      return keylessAnswer('duckduckgo', again.hits, request, [`${failureLine(html.failure)} — answered on one retry after ${(waitedMs / 1000).toFixed(1)}s`, failureLine(lite.failure)])
    }
    if (again.failure.kind === 'aborted') return again.failure
    retry = { waitedMs, failure: again.failure }
  }

  const htmlFinal = retry?.failure ?? html.failure
  if (html.knocked && htmlFinal.kind === 'rate-limited') noteRateLimited('duckduckgo', clock)
  if (lite.knocked && lite.failure.kind === 'rate-limited') noteRateLimited('duckduckgo-lite', clock)
  const coolDownMs = Math.max(coolDownRemainingMs('duckduckgo', clock.now()), coolDownRemainingMs('duckduckgo-lite', clock.now()))
  if (!html.knocked && !lite.knocked) {
    return searchFailure('rate-limited', 'duckduckgo-lite', `cooling down after a rate limit — ${secondsLeftLabel(coolDownMs)} left before the next knock (both doors); no request was made`)
  }
  const retryWords = retry
    ? retry.failure.kind === html.failure.kind && retry.failure.message === html.failure.message
      ? `; the same on one retry after ${(retry.waitedMs / 1000).toFixed(1)}s`
      : `; on one retry after ${(retry.waitedMs / 1000).toFixed(1)}s: ${retry.failure.kind} — ${retry.failure.message}`
    : ''
  const cooling = coolDownMs > 0 ? `; cooling down ${secondsLeftLabel(coolDownMs)} before the next knock` : ''
  return searchFailure(lite.failure.kind, 'duckduckgo-lite', `${lite.failure.message} (the html door: ${html.failure.kind} — ${html.failure.message}${retryWords})${cooling}`)
}

export const duckduckgoBackend: SearchBackend = {
  id: 'duckduckgo',
  tier: 'keyless',
  search: request => keylessSearch(request),
}
