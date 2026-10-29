import { LRUCache } from 'lru-cache'

import { querySmallFast, queryWithModel } from '../../services/providers/anthropic/index.js'
import { getEngineModel } from '../../utils/model/model.js'
import { sessionSmallFastModel } from '../../utils/model/providerFrontier.js'
import { AbortError } from '../../utils/errors.js'
import { isBinaryContentType, persistBinaryContent } from '../../utils/mcpOutputStorage.js'
import { extractTextContent } from '../../utils/messages/text.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { makeSecondaryModelPrompt, WEB_FETCH_TOOL_NAME } from './prompt.js'
import { isPreapprovedHost } from './preapproved.js'
import { extractMainHtml } from './extractHtml.js'
import { addTableRule } from './tableRule.js'
import { readHostedPage, fetchReaderEnabled } from './reader.js'
import { FetchRefusedError } from './fetchErrors.js'
import { fetchPage, type RawResponse, type RedirectResult } from './fetchTransport.js'
import { pageAccessNotice } from './pageAccess.js'
import { arxivPaperUrl, resetStructuredFetchPacing, tryStructuredFetch } from './structuredHosts.js'
import { extractPdfText, renderPdfText } from '../../utils/pdfText.js'
import { recognisePdfPage, renderOcr } from '../../utils/ocr.js'
export type { RedirectResult } from './fetchTransport.js'
export { EgressBlockedError } from './fetchErrors.js'

const MAX_URL_LENGTH = 2000

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

const urlCache = new LRUCache<string, FetchedContent>({
  ttl: 15 * 60 * 1000,
  ttlAutopurge: true,
  maxSize: 50 * 1024 * 1024,
  sizeCalculation: entry => Math.max(1, entry.content.length),
})

export function clearWebFetchCache(): void {
  urlCache.clear()
  resetStructuredFetchPacing()
}

function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH || /^https?:[\\/]*[^/?#]*\\/i.test(url.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\r\n]/g, ''))) return false
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
  if (!validateURL(url)) return false
  try {
    const parsed = new URL(url)
    return isPreapprovedHost(parsed.hostname, parsed.pathname)
  } catch {
    return false
  }
}

let markdownConverter: { turndown: (html: string) => string } | null = null

async function convertHtmlToMarkdown(html: string): Promise<string> {
  if (!markdownConverter) {
    const { default: TurndownService } = await import('turndown')
    const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    const escape = service.escape.bind(service)
    service.escape = text => escape(text).replace(/(?<=[\p{L}\p{N}])(?:\\_)+(?=[\p{L}\p{N}])/gu, value => value.replaceAll('\\_', '_'))
    addTableRule(service)
    markdownConverter = service
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
  const upgraded = arxivPaperUrl(parsedForUpgrade.toString()) ?? parsedForUpgrade.toString()

  const structured = await tryStructuredFetch(upgraded, abortController.signal)
  if (structured !== null) {
    urlCache.set(cacheKey, structured, { size: Math.max(1, Buffer.byteLength(structured.content, 'utf8')) })
    return structured
  }

  const response = await fetchPage(upgraded, abortController.signal)
  if ('type' in response && response.type === 'redirect') {

    return response
  }
  const raw = response as RawResponse

  const buffer = Buffer.from(raw.data)
  raw.data = new ArrayBuffer(0)

  const contentType = buffer.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf' : String(raw.headers?.['content-type'] ?? '').toLowerCase()

  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    const identifier = ['webfetch', Date.now(), Math.random().toString(36).slice(2, 8)].join('-')
    const persisted = await persistBinaryContent(buffer, contentType, identifier)
    if ('error' in persisted) throw new FetchRefusedError(0, 'The binary document was received but could not be saved; no extracted text is available.')
    persistedPath = persisted.filepath
    persistedSize = persisted.size
  }

  const charset = /;\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(contentType)
  const encoding = charset?.[1] ?? charset?.[2] ?? charset?.[3] ?? 'utf-8'
  const decoded = persistedPath ? '' : new TextDecoder(encoding.trim()).decode(buffer)
  let content: string
  let cachedSize: number
  let notice: string | undefined
  let cacheable = true
  if (persistedPath) {
    content = ''
    if (contentType.includes('application/pdf')) {
      try {
        const document = await extractPdfText(persistedPath, { signal: abortController.signal })
        const first = document.pages[0]
        if (first && !first.hasTextLayer) {
          const ocr = await recognisePdfPage(persistedPath, buffer, 1, abortController.signal)
          if (ocr.ok) content = `--- page 1 ---\n${renderOcr(ocr)}`
          else notice = ocr.message
        } else content = renderPdfText(document, 1, 1)
        if (content.length > 4000) content = `${content.slice(0, 4000)}\n[First-page preview cut at 4000 characters; Read the saved file for the rest.]`
      } catch (error) {
        abortController.signal.throwIfAborted()
        notice = `PDF text extraction failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    cachedSize = Math.max(1, content.length)
  } else if (contentType.includes('text/html')) {
    const refusal = pageAccessNotice(decoded)
    if (refusal) throw new FetchRefusedError(403, refusal)
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

interface FetchSummariseReads {
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
    const content = response.message.content
    const text = typeof content === 'string' ? content : extractTextContent(content, '\n')
    return text.trim() === '' ? null : text
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
