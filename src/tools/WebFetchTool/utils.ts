import axios, { type AxiosResponse } from 'axios'
import { LRUCache } from 'lru-cache'

import { querySmallFast, queryWithModel } from '../../services/providers/anthropic/index.js'
import { getEngineModel } from '../../utils/model/model.js'
import { sessionSmallFastModel } from '../../utils/model/providerFrontier.js'
import { AbortError } from '../../utils/errors.js'
import { getWebFetchUserAgent } from '../../utils/http.js'
import { isBinaryContentType, persistBinaryContent } from '../../utils/mcpOutputStorage.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { makeSecondaryModelPrompt, WEB_FETCH_TOOL_NAME } from './prompt.js'
import { isPreapprovedHost } from './preapproved.js'
import { extractMainHtml } from './extractHtml.js'
import { readHostedPage, fetchReaderEnabled } from './reader.js'
import { EgressBlockedError } from './fetchErrors.js'
export { EgressBlockedError } from './fetchErrors.js'


const MAX_URL_LENGTH = 2000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const FETCH_TIMEOUT_MS = 60_000
const MAX_REDIRECT_HOPS = 10

type FetchedContent = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
  notice?: string
}

export type RedirectResult = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

const urlCache = new LRUCache<string, FetchedContent>({
  ttl: 15 * 60 * 1000,
  ttlAutopurge: true,
  maxSize: 50 * 1024 * 1024,
  sizeCalculation: entry => Math.max(1, entry.content.length),
})

export function clearWebFetchCache(): void {
  urlCache.clear()
}


function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return false
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

function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
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

type RawResponse = { url: string; status: number; statusText: string; headers: Record<string, unknown>; data: ArrayBuffer }

async function getWithPermittedRedirects(
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
    url,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers as Record<string, unknown>,
    data: response.data,
  }
}

let markdownConverter: { turndown: (html: string) => string } | null = null

async function convertHtmlToMarkdown(html: string): Promise<string> {
  if (!markdownConverter) {
    const { default: TurndownService } = await import('turndown')
    markdownConverter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  }
  return markdownConverter.turndown(html)
}

export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectResult> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }
  const cacheKey = `${fetchReaderEnabled() ? 1 : 0}:${url}`
  const cached = urlCache.get(cacheKey)
  if (cached) return cached

  const parsedForUpgrade = new URL(url)
  if (parsedForUpgrade.protocol === 'http:') parsedForUpgrade.protocol = 'https:'
  const upgraded = parsedForUpgrade.toString()

  const response = await getWithPermittedRedirects(upgraded, abortController.signal, isPermittedRedirect)
  if ('type' in response && response.type === 'redirect') {
    return response
  }
  const raw = response as RawResponse

  const buffer = Buffer.from(raw.data)
  raw.data = new ArrayBuffer(0)

  const contentType = String(raw.headers?.['content-type'] ?? '')

  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    const identifier = ['webfetch', Date.now(), Math.random().toString(36).slice(2, 8)].join('-')
    const persisted = await persistBinaryContent(buffer, contentType, identifier)
    if ('filepath' in persisted) {
      persistedPath = persisted.filepath
      persistedSize = persisted.size
    }
  }

  const decoded = buffer.toString('utf8')
  let content: string
  let cachedSize: number
  let notice: string | undefined
  let cacheable = true
  if (contentType.includes('text/html')) {
    const extracted = extractMainHtml(decoded)
    content = await convertHtmlToMarkdown(extracted.html)
    if (extracted.sparse) {
      const rendered = await readHostedPage(isPreapprovedUrl(url) ? url : raw.url, abortController.signal)
      notice = rendered.notice
      cacheable = rendered.content !== undefined
      if (rendered.content !== undefined) content = rendered.content
    }
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
    ...(notice ? { notice } : {}),
    ...(persistedPath !== undefined ? { persistedPath } : {}),
    ...(persistedSize !== undefined ? { persistedSize } : {}),
  }
  if (cacheable) urlCache.set(cacheKey, result, { size: Math.max(1, cachedSize) })
  return result
}

export interface FetchSummariseReads {
  small?: typeof querySmallFast
  withModel?: typeof queryWithModel
  smallModelId?: () => string
  mainModelId?: () => string
}

export async function applyPromptToMarkdown(
  prompt: string,
  markdown: string,
  signal: AbortSignal,
  isNonInteractive: boolean,
  isPreapprovedDomain: boolean,
  reads?: FetchSummariseReads,
): Promise<string> {
  const bounded = markdown
  const small = reads?.small ?? querySmallFast
  const withModel = reads?.withModel ?? queryWithModel
  const smallModelId = reads?.smallModelId ?? sessionSmallFastModel
  const mainModelId = reads?.mainModelId ?? getEngineModel
  const userPrompt = makeSecondaryModelPrompt(bounded, prompt, isPreapprovedDomain)
  const baseOptions = {
    querySource: 'web_fetch_apply' as const,
    isNonInteractiveSession: isNonInteractive,
    agents: [],
    mcpTools: [],
    hasAppendSystemPrompt: false,
  }
  const textOf = (response: Awaited<ReturnType<typeof querySmallFast>>): string | null => {
    const first = response.message.content[0]
    return first?.type === 'text' ? first.text : null
  }
  const refusalOf = (response: Awaited<ReturnType<typeof querySmallFast>>): string | null =>
    response.isApiErrorMessage === true ? (textOf(response) ?? 'the reply carried no text') : null
  const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  const idOf = (fn: () => string): string => {
    try {
      return fn()
    } catch {
      return ''
    }
  }

  const primaryModel = idOf(smallModelId)
  let primaryReason: string
  try {
    const response = await small({ systemPrompt: asSystemPrompt([]), userPrompt, signal, options: baseOptions })
    if (signal.aborted) throw new AbortError()
    const refusal = refusalOf(response)
    const text = refusal === null ? textOf(response) : null
    if (text !== null) return `[Model reading of the extracted page, not the page’s own words.]\n\n${text}`
    if (refusal === null) throw new Error('the reply carried no text')
    primaryReason = refusal
  } catch (error) {
    if (signal.aborted || error instanceof AbortError) throw new AbortError()
    primaryReason = reasonOf(error)
  }

  const fallbackModel = idOf(mainModelId)
  let fallbackReason: string | null = null
  if (fallbackModel !== '' && fallbackModel !== primaryModel) {
    try {
      const response = await withModel({ systemPrompt: asSystemPrompt([]), userPrompt, signal, options: { ...baseOptions, model: fallbackModel } })
      if (signal.aborted) throw new AbortError()
      const refusal = refusalOf(response)
      const text = refusal === null ? textOf(response) : null
      if (text !== null) return `[Model reading of the extracted page, not the page’s own words.]\n\n${text}`
      fallbackReason = refusal ?? 'the reply carried no text'
    } catch (error) {
      if (signal.aborted || error instanceof AbortError) throw new AbortError()
      fallbackReason = reasonOf(error)
    }
  }

  const quoteGuard = isPreapprovedDomain
    ? ''
    : ' When quoting from this content, keep every quotation under 125 characters and never reproduce song lyrics verbatim.'
  const road =
    fallbackReason === null
      ? `tried the small-fast model ${primaryModel || 'unknown'} (${primaryReason}); the session model is the same, so there was no second road`
      : `tried the small-fast model ${primaryModel || 'unknown'} (${primaryReason}), then the session model ${fallbackModel || 'unknown'} (${fallbackReason})`
  return `[The page was fetched, but no summariser model was available, so this is the page content itself, not an answer to the prompt.${quoteGuard} Road: ${road}.]\n\n${bounded}`
}

export { WEB_FETCH_TOOL_NAME }
