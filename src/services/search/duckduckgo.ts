import { flagEnv } from '../../substrate/flagRegistry.js'
import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import { DUCKDUCKGO_OFF_DOORS, DUCKDUCKGO_TERMS, duckduckgoScrapingEnabled } from './searchSetting.js'
import { htmlToText, readAttribute } from './htmlText.js'
import {
  liveSearchClock,
  noteAnswered,
  noteRateLimited,
  serverSearchWaitMs,
  withSearchTurn,
  takeSearchNotice,
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
      snippet: snippet ? htmlToText(snippet[2] ?? '') : '',
      source_type: 'duckduckgo',
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
      hits.push({ title: htmlToText(match[2] ?? ''), url, snippet: '', source_type: 'duckduckgo' })
    } else {
      const last = hits.at(-1)
      if (last && last.snippet === '') last.snippet = htmlToText(match[3] ?? '')
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

export interface KeylessSearchIo { fetchImpl?: typeof fetch; clock?: SearchClock; enabled?: boolean }
type KeylessDoor = 'duckduckgo' | 'duckduckgo-lite'
const DDG_RATE_POLICY = { intervalMs: 3000, why: 'Read 2026-10-13: https://duckduckgo.com/terms and https://duckduckgo.com/acceptable-use — no blanket automation ban and no published API rate for these pages; on by default and off by the user\'s choice is Mercury policy (the owner\'s ruling 2026-10-14). Client courtesy: serial requests three seconds apart; refusal stops both hosts, Retry-After and exponential backoff are respected.' }

async function attemptDoor(door: KeylessDoor, url: string, request: SearchRequest, io: KeylessSearchIo, clock: SearchClock): Promise<SearchOutcome> {
  const form = new URLSearchParams({ q: keylessQueryFor(request), kl: 'us-en' })
  if (door === 'duckduckgo') form.set('b', '')
  let response: Response
  try {
    response = await fetchWithProviderDeadline(io.fetchImpl ?? getApiFetch(), 'DuckDuckGo', REQUEST_TIMEOUT_MS, url, {
      ...(io.fetchImpl ? {} : getProxyFetchOptions()), method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', 'accept-language': 'en-US,en;q=0.9', 'user-agent': searchUserAgent() },
      body: form.toString(), ...(request.signal ? { signal: request.signal } : {}),
    })
  } catch {
    return searchFailure(request.signal?.aborted ? 'aborted' : 'network', door, request.signal?.aborted ? 'cancelled' : 'the request did not complete')
  }
  if ([202, 403, 429, 503].includes(response.status)) {
    const delay = noteRateLimited('duckduckgo', clock, serverSearchWaitMs(response.headers, clock.now()))
    await response.body?.cancel()
    return searchFailure('rate-limited', door, `the site refused automated access; cooling down ${secondsLeftLabel(delay)}; no retry or host swap`)
  }
  if (response.status !== 200) {
    await response.body?.cancel()
    return searchFailure('network', door, 'the page endpoint did not answer')
  }
  let body: string
  try { body = await response.text() } catch { return searchFailure(request.signal?.aborted ? 'aborted' : 'network', door, request.signal?.aborted ? 'cancelled' : 'the page body could not be read') }
  if (request.signal?.aborted) return searchFailure('aborted', door, 'cancelled')
  const page = door === 'duckduckgo' ? parseDuckDuckGoHtml(body) : parseDuckDuckGoLite(body)
  if (page.kind === 'challenge') {
    const delay = noteRateLimited('duckduckgo', clock, serverSearchWaitMs(response.headers, clock.now()))
    return searchFailure('rate-limited', door, `the bot challenge page refused automated access; cooling down ${secondsLeftLabel(delay)}; no retry or host swap`)
  }
  if (page.kind === 'unrecognised') return searchFailure('parse-failed', door, page.reason)
  noteAnswered('duckduckgo')
  return { ok: true, via: door, tier: 'keyless', hits: normaliseHits(filterHitsByDomain(page.hits, request.allowedDomains, request.blockedDomains), request.maxResults ?? DEFAULT_MAX_RESULTS) }
}
export async function keylessSearch(request: SearchRequest, io: KeylessSearchIo = {}): Promise<SearchOutcome> {
  if (request.signal?.aborted) return searchFailure('aborted', 'duckduckgo', 'cancelled')
  if (!(io.enabled ?? duckduckgoScrapingEnabled())) return searchFailure('no-backend', 'duckduckgo', `DuckDuckGo page scraping is off (${DUCKDUCKGO_OFF_DOORS})`)
  const clock = io.clock ?? liveSearchClock
  const notes: string[] = []
  let outcome = await withSearchTurn('duckduckgo', DDG_RATE_POLICY, clock, request.signal, async waitMs => {
    if (request.signal?.aborted) return searchFailure('aborted', 'duckduckgo', 'cancelled')
    if (waitMs > 0) return searchFailure('rate-limited', 'duckduckgo', `cooling down ${secondsLeftLabel(waitMs)}; no request was made`)
    return attemptDoor('duckduckgo', duckduckgoHtmlUrl(), request, io, clock)
  })
  if (!outcome.ok && (outcome.kind === 'network' || outcome.kind === 'parse-failed')) {
    notes.push(failureLine(outcome))
    outcome = await withSearchTurn('duckduckgo', DDG_RATE_POLICY, clock, request.signal, async waitMs => {
      if (request.signal?.aborted) return searchFailure('aborted', 'duckduckgo-lite', 'cancelled')
      if (waitMs > 0) return searchFailure('rate-limited', 'duckduckgo', `cooling down ${secondsLeftLabel(waitMs)}; no request was made`)
      return attemptDoor('duckduckgo-lite', duckduckgoLiteUrl(), request, io, clock)
    })
  }
  if (!outcome.ok && outcome.kind === 'aborted') return outcome
  const notice = takeSearchNotice('duckduckgo-terms', DUCKDUCKGO_TERMS)
  if (notice) notes.unshift(notice)
  if (outcome.ok) return { ...outcome, notes }
  return { ...outcome, message: [...notes, outcome.message].join(' ') }
}
