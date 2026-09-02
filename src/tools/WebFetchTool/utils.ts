import axios, { type AxiosResponse } from 'axios'
import { LRUCache } from 'lru-cache'

import { querySmallFast } from '../../services/providers/anthropic/index.js'
import { declaredRouteOf } from '../../services/providers/routeLaw.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { AbortError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getWebFetchUserAgent } from '../../utils/http.js'
import { isBinaryContentType, persistBinaryContent } from '../../utils/mcpOutputStorage.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { makeSecondaryModelPrompt, WEB_FETCH_TOOL_NAME } from './prompt.js'
import { isPreapprovedHost } from './preapproved.js'

/**
 * HTTP fetch with a manual same-host redirect policy, remote domain
 * preflight, a self-cleaning content cache, HTML-to-markdown conversion,
 * and secondary-model summarisation.
 */

const MAX_URL_LENGTH = 2000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const FETCH_TIMEOUT_MS = 60_000
const PREFLIGHT_TIMEOUT_MS = 10_000
const MAX_REDIRECT_HOPS = 10
export const MAX_MARKDOWN_LENGTH = 100_000

export type FetchedContent = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

export type RedirectResult = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

// 15-minute TTL, 50 MB budget sized by converted content length.
// ttlAutopurge keeps the "self-cleaning" promise literal: without it,
// lru-cache stops SERVING an expired page but its bytes linger until
// size-displaced — page-sized values in a long-lived session earn the
// per-entry purge timer. The domain cache below deliberately skips it
// (128 boolean entries; a timer apiece would outweigh what it frees).
const urlCache = new LRUCache<string, FetchedContent>({
  ttl: 15 * 60 * 1000,
  ttlAutopurge: true,
  maxSize: 50 * 1024 * 1024,
  sizeCalculation: entry => Math.max(1, entry.content.length),
})

// Deliberately shorter-lived than the URL cache; only ALLOWED verdicts are
// cached — blocked and failed outcomes re-check on the next attempt.
const domainCheckCache = new LRUCache<string, true>({ max: 128, ttl: 5 * 60 * 1000 })

export function clearWebFetchCache(): void {
  urlCache.clear()
  domainCheckCache.clear()
}

export class DomainBlockedError extends Error {
  constructor(domain: string) {
    super(`Fetching from the domain ${domain} is not permitted.`)
    this.name = 'DomainBlockedError'
  }
}

export class DomainCheckFailedError extends Error {
  constructor(domain: string) {
    super(
      `Could not verify whether ${domain} is safe to fetch. This may be due to network restrictions or enterprise security policies blocking api.anthropic.com.`,
    )
    this.name = 'DomainCheckFailedError'
  }
}

/** The egress proxy's blocked-by-allowlist signal, re-shaped for callers that parse it. */
export class EgressBlockedError extends Error {
  public readonly domain: string
  constructor(domain: string) {
    super(
      JSON.stringify({
        error_type: 'EGRESS_BLOCKED',
        domain,
        message: `Access to ${domain} is blocked by the network egress proxy.`,
      }),
    )
    this.name = 'EgressBlockedError'
    this.domain = domain
  }
}

/**
 * A first-pass gate, deliberately protocol-free (HTTP upgrades to HTTPS at
 * request time): length, parseability, no credentials (the tool must not
 * aim at cookies or internal domains), and a publicly-resolvable-looking
 * hostname (at least two dot-separated labels).
 */
export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) return false
  if (parsed.hostname.split('.').length < 2) return false
  return true
}

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return isPreapprovedHost(parsed.hostname, parsed.pathname)
  } catch {
    return false
  }
}

/** The preflight's host is HARDCODED first-party (deliberately not the
 *  base-URL override — a gateway would not serve this policy endpoint);
 *  the flagEnv row is the proof seam a loopback spy stands in through. */
const DOMAIN_PREFLIGHT_URL = 'https://api.anthropic.com/api/web/domain_info'
function domainPreflightUrl(): string {
  return flagEnv('MERCURY_WEBFETCH_PREFLIGHT_URL')?.trim() || DOMAIN_PREFLIGHT_URL
}

/**
 * The remote blocklist preflight. Only "allowed" is cached. A thrown check
 * error logs once here and becomes the failed outcome.
 */
export async function checkDomainBlocklist(
  domain: string,
): Promise<{ status: 'allowed' | 'blocked' | 'check_failed'; error?: Error }> {
  if (domainCheckCache.has(domain)) return { status: 'allowed' }
  try {
    const response = await axios.get(
      `${domainPreflightUrl()}?domain=${encodeURIComponent(domain)}`,
      { timeout: PREFLIGHT_TIMEOUT_MS },
    )
    if (response.status !== 200) {
      return { status: 'check_failed', error: new Error(`HTTP ${response.status}`) }
    }
    if ((response.data as { can_fetch?: unknown })?.can_fetch === true) {
      domainCheckCache.set(domain, true)
      return { status: 'allowed' }
    }
    return { status: 'blocked' }
  } catch (error) {
    logError(error)
    return { status: 'check_failed', error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/**
 * A redirect is followed only when nothing that matters changes: same
 * protocol, same port, no credentials on the target, and hostnames equal
 * after stripping one leading `www.` from each. Anything else is reported
 * back — an open-redirect flaw on a trusted host must not silently steer
 * the fetch to an attacker-controlled server.
 */
export function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  let original: URL
  let redirect: URL
  try {
    original = new URL(originalUrl)
    redirect = new URL(redirectUrl)
  } catch {
    return false
  }
  if (original.protocol !== redirect.protocol) return false
  if (original.port !== redirect.port) return false
  if (redirect.username || redirect.password) return false
  const strip = (host: string): string => host.replace(/^www\./, '')
  return strip(original.hostname) === strip(redirect.hostname)
}

const REDIRECT_STATUSES = new Set([301, 302, 307, 308])

type RawResponse = { status: number; statusText: string; headers: Record<string, unknown>; data: ArrayBuffer }

/**
 * GET with redirects disabled at the client (the policy above is applied
 * manually). The hop cap exists because the request timeout resets per
 * hop, so a malicious redirect loop would otherwise hang until the user
 * interrupts: ten redirects are followed and the eleventh throws.
 */
export async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal | undefined,
  redirectChecker: (from: string, to: string) => boolean,
  depth = 0,
): Promise<RawResponse | RedirectResult> {
  if (depth > MAX_REDIRECT_HOPS) {
    throw new Error(`Too many redirects (limit ${MAX_REDIRECT_HOPS})`)
  }
  let response: AxiosResponse<ArrayBuffer>
  try {
    response = await axios.get<ArrayBuffer>(url, {
      signal,
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: 'arraybuffer',
      maxContentLength: MAX_RESPONSE_BYTES,
      headers: {
        Accept: 'text/markdown, text/html, */*',
        'User-Agent': getWebFetchUserAgent(),
      },
    })
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const status = error.response.status
      const proxyHeader = error.response.headers?.['x-proxy-error']
      if (status === 403 && proxyHeader === 'blocked-by-allowlist') {
        throw new EgressBlockedError(new URL(url).hostname)
      }
      if (REDIRECT_STATUSES.has(status)) {
        const location = error.response.headers?.location
        if (typeof location !== 'string' || location.length === 0) {
          throw new Error(`Redirect response ${status} carried no location header`)
        }
        const target = new URL(location, url).toString()
        if (!redirectChecker(url, target)) {
          return { type: 'redirect', originalUrl: url, redirectUrl: target, statusCode: status }
        }
        return getWithPermittedRedirects(target, signal, redirectChecker, depth + 1)
      }
    }
    throw error
  }
  const proxyHeader = (response.headers as Record<string, unknown>)?.['x-proxy-error']
  if (response.status === 403 && proxyHeader === 'blocked-by-allowlist') {
    throw new EgressBlockedError(new URL(url).hostname)
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers as Record<string, unknown>,
    data: response.data,
  }
}

// Construction is expensive while conversion is stateless, and the
// dependency is ~1.4 MB — loaded on the first HTML fetch and reused.
let markdownConverter: { turndown: (html: string) => string } | null = null

async function convertHtmlToMarkdown(html: string): Promise<string> {
  if (!markdownConverter) {
    const { default: TurndownService } = await import('turndown')
    markdownConverter = new TurndownService()
  }
  return markdownConverter.turndown(html)
}

/**
 * Validate → cache (a hit skips upgrade, preflight, and network) → HTTPS
 * upgrade → preflight → fetch → binary supplement → decode/convert →
 * cache under the ORIGINAL url.
 */
export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectResult> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }
  const cached = urlCache.get(url)
  if (cached) return cached

  // HTTPS upgrade by parse + re-serialisation: the URL parser lower-cases
  // the scheme (so HTTP:// upgrades too) and normalises the serialised form.
  const parsedForUpgrade = new URL(url)
  if (parsedForUpgrade.protocol === 'http:') parsedForUpgrade.protocol = 'https:'
  const upgraded = parsedForUpgrade.toString()
  const hostname = new URL(upgraded).hostname

  try {
    // The domain preflight is the FIRST PARTY's policy service (the
    // hardcoded api.anthropic.com endpoint above), so it runs ONLY for a
    // session whose main model routes to anthropic (ruled — the
    // family-honesty class: a sovereign home makes zero first-party hops,
    // and an unreachable api.anthropic.com must not fail another family's
    // fetch). Every family keeps Mercury's own URL validation and the
    // hostname-scoped permission gate.
    const skipPreflight = (await import('../../utils/settings/settings.js')).getSettings_DEPRECATED()
      ?.skipWebFetchPreflight
    if (!skipPreflight && declaredRouteOf(getMainLoopModel()) === 'anthropic') {
      const verdict = await checkDomainBlocklist(hostname)
      if (verdict.status === 'blocked') throw new DomainBlockedError(hostname)
      if (verdict.status === 'check_failed') throw new DomainCheckFailedError(hostname)
    }
  } catch (error) {
    // The blocked and check-failed outcomes are expected user-facing
    // failures, never logged as internal errors; anything else inside the
    // preflight block logs and the fetch proceeds.
    if (error instanceof DomainBlockedError || error instanceof DomainCheckFailedError) throw error
    logError(error)
  }

  const response = await getWithPermittedRedirects(upgraded, abortController.signal, isPermittedRedirect)
  if ('type' in response && response.type === 'redirect') {
    // As produced by the walker: its original-URL field is the url at the
    // failing hop, never overwritten with the input url.
    return response
  }
  const raw = response as RawResponse

  // Copy then release the client's copy: the markdown converter's document
  // tree can be several times the HTML size, so the 10 MiB body must be
  // reclaimable first.
  const buffer = Buffer.from(raw.data)
  raw.data = new ArrayBuffer(0)

  const contentType = String(raw.headers?.['content-type'] ?? '')

  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    // A supplement, not a replacement: the decoded string retains enough
    // ASCII structure for the small model to summarise (PDFs especially),
    // and the saved file lets the product inspect the original. A
    // persistence failure propagates.
    // A tool-specific prefix, the timestamp, and a short random suffix;
    // the extension is derived from the MIME type by the storage owner.
    const identifier = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const persisted = await persistBinaryContent(buffer, contentType, identifier)
    if ('filepath' in persisted) {
      persistedPath = persisted.filepath
      persistedSize = persisted.size
    }
  }

  const decoded = buffer.toString('utf8')
  let content: string
  let cachedSize: number
  if (contentType.includes('text/html')) {
    content = await convertHtmlToMarkdown(decoded)
    cachedSize = Buffer.byteLength(content, 'utf8')
  } else {
    content = decoded
    cachedSize = buffer.byteLength
  }

  const result: FetchedContent = {
    bytes: buffer.byteLength,
    code: raw.status,
    codeText: raw.statusText,
    content,
    contentType,
    ...(persistedPath !== undefined ? { persistedPath } : {}),
    ...(persistedSize !== undefined ? { persistedSize } : {}),
  }
  // The cache requires positive sizes; an empty response is clamped to 1.
  urlCache.set(url, result, { size: Math.max(1, cachedSize) })
  return result
}

/**
 * Truncate at the ceiling, run the trust-dependent secondary-model prompt,
 * and throw the abort error AFTER the call when the signal aborted so the
 * transcript shows an error state rather than a stale success.
 */
export async function applyPromptToMarkdown(
  prompt: string,
  markdown: string,
  signal: AbortSignal,
  isNonInteractive: boolean,
  isPreapprovedDomain: boolean,
): Promise<string> {
  let bounded = markdown
  if (bounded.length > MAX_MARKDOWN_LENGTH) {
    bounded = `${bounded.slice(0, MAX_MARKDOWN_LENGTH)}\n\n[Content truncated due to length...]`
  }
  let response
  try {
    response = await querySmallFast({
      systemPrompt: asSystemPrompt([]),
      userPrompt: makeSecondaryModelPrompt(bounded, prompt, isPreapprovedDomain),
      signal,
      options: {
        querySource: 'web_fetch_apply',
        isNonInteractiveSession: isNonInteractive,
        agents: [],
        mcpTools: [],
        hasAppendSystemPrompt: false,
      },
    })
  } catch (error) {
    if (signal.aborted || error instanceof AbortError) throw new AbortError()
    // The FETCH succeeded; only the extraction leg (the session family's
    // own small-fast tier through the routed seam) failed. That is a
    // warning-class fact: deliver the
    // fetched content with an honest note instead of failing the turn
    // (block only correctness — warn on the rest). The quote ceiling that
    // normally rides the extraction prompt is a legal constraint, so the
    // degraded passthrough restates it for non-preapproved domains.
    const reason = error instanceof Error ? error.message : String(error)
    const quoteGuard = isPreapprovedDomain
      ? ''
      : ' When quoting from this content, keep every quotation under 125 characters and never reproduce song lyrics verbatim.'
    return `[The extraction model was unavailable, so this is the fetched page content itself, not an answer to the prompt.${quoteGuard} Extraction failure: ${reason}]\n\n${bounded}`
  }
  if (signal.aborted) {
    throw new AbortError()
  }
  const first = response.message.content[0]
  return first?.type === 'text' ? first.text : 'No response from model'
}

export { WEB_FETCH_TOOL_NAME }
