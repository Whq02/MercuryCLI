import { LRUCache } from 'lru-cache'

import { callUtilityModel, callWithModel } from '../../models/roads/anthropic/index.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { utilityCallFor } from '../../models/catalogue/utilityModel.js'
import { AbortError } from '../../platform/errors/errors.js'
import { isBinaryContentType, persistBinaryContent } from '../../integrations/mcp/mcpOutputStorage.js'
import { extractTextContent } from '../../engine/message-shapes/text.js'
import { asSystemPrompt } from '../../engine/system-prompt/systemPromptType.js'
import { makeSecondaryModelPrompt, WEB_FETCH_TOOL_NAME } from './prompt.js'
import { isPreapprovedHost } from './preapproved.js'
import { extractMainHtml } from './extractHtml.js'
import { addTableRule } from './tableRule.js'
import { readHostedPage, fetchReaderEnabled } from './reader.js'
import { FetchRefusedError } from './fetchErrors.js'
import { fetchPage, type RawResponse, type RedirectResult } from './fetchTransport.js'
import { pageAccessNotice } from './pageAccess.js'
import { arxivPaperUrl, resetStructuredFetchPacing, tryStructuredFetch } from './structuredHosts.js'
import type TurndownService from 'turndown'
import { extractPdfText, renderPdfText } from '../kit/pdfText.js'
import { recognisePdfPage, renderOcr } from '../kit/ocr.js'
import { passedOver } from '../../platform/errors/passedOver.js'
export { EgressBlockedError } from './fetchErrors.js'

type FetchedContent = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  notice?: string
  persistedPath?: string
  persistedSize?: number
  type?: never
}

const URL_CACHE_TTL_MS = 15 * 60 * 1000
const URL_CACHE_MAX_SIZE = 50 * 1024 * 1024
const MAX_URL_LENGTH = 2000
const PDF_PREVIEW_MAX_CHARS = 4000

const urlCache = new LRUCache<string, FetchedContent>({
  ttl: URL_CACHE_TTL_MS,
  ttlAutopurge: true,
  maxSize: URL_CACHE_MAX_SIZE,
  sizeCalculation: entry => Math.max(1, entry.content.length),
})

let markdownConverter: Promise<TurndownService> | undefined

async function getMarkdownConverter(): Promise<TurndownService> {
  if (!markdownConverter) {
    markdownConverter = import('turndown').then(mod => {
      const TurndownCtor = mod.default
      const service = new TurndownCtor({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
      })
      const baseEscape = service.escape.bind(service)
      service.escape = (text: string) =>
        baseEscape(text).replace(/(?<=[\p{L}\p{N}])(?:\\_)+(?=[\p{L}\p{N}])/gu, match => match.replace(/\\_/g, '_'))
      addTableRule(service)
      return service
    })
  }
  return markdownConverter
}

export function clearWebFetchCache(): void {
  urlCache.clear()
  resetStructuredFetchPacing()
}

function parseValidUrl(raw: string): URL | null {
  if (raw.length > MAX_URL_LENGTH) return null
  const trimmed = raw.replace(/^[\u0000-\u0020]+/, '')
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):([\s\S]*)$/.exec(trimmed)
  if (!schemeMatch) return null
  const scheme = schemeMatch[1]!.toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') return null
  const afterColon = schemeMatch[2]!
  const authorityPart = afterColon.replace(/^\/+/, '').split(/[/?#]/, 1)[0] ?? ''
  if (afterColon.startsWith('\\') || authorityPart.includes('\\')) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (error) {
    passedOver(error)
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  if (parsed.hostname.split('.').filter(Boolean).length < 2) return null
  return parsed
}

export function isPreapprovedUrl(url: string): boolean {
  const parsed = parseValidUrl(url)
  if (!parsed) return false
  return isPreapprovedHost(parsed.hostname, parsed.pathname)
}

function parseCharset(contentType: string): string {
  const match = /;\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType)
  const label = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
  return label || 'utf-8'
}

function decodeText(bytes: Buffer, contentType: string): string {
  const charset = parseCharset(contentType)
  return new TextDecoder(charset).decode(bytes)
}

async function handleBinaryResponse(
  rawBytes: Buffer,
  contentType: string,
  response: RawResponse,
  signal: AbortSignal,
): Promise<FetchedContent> {
  const persisted = await persistBinaryContent(
    rawBytes,
    contentType,
    `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  if ('error' in persisted) {
    throw new FetchRefusedError(
      response.status,
      'The binary document was received but could not be saved; no extracted text is available.',
    )
  }
  let content = ''
  let notice: string | undefined
  if (contentType.includes('application/pdf')) {
    try {
      const doc = await extractPdfText(persisted.filepath, { signal })
      const page1 = doc.pages.find(p => p.pageNumber === 1) ?? doc.pages[0]
      let preview = ''
      if (page1 && !page1.hasTextLayer) {
        const ocr = await recognisePdfPage(persisted.filepath, rawBytes, 1, signal)
        if (ocr.ok) {
          preview = renderOcr(ocr)
        } else {
          notice = ocr.message
        }
      } else if (page1) {
        preview = renderPdfText(doc, 1, 1)
      }
      if (preview.length > PDF_PREVIEW_MAX_CHARS) {
        preview = `${preview.slice(0, PDF_PREVIEW_MAX_CHARS)}\n\n[First-page preview cut at 4000 characters; Read the saved file for the rest.]`
      }
      content = preview
    } catch (error) {
      if (signal.aborted || error instanceof AbortError) throw new AbortError()
      notice = `PDF text extraction failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    bytes: rawBytes.byteLength,
    code: response.status,
    codeText: response.statusText,
    content,
    contentType,
    ...(notice !== undefined ? { notice } : {}),
    persistedPath: persisted.filepath,
    persistedSize: persisted.size,
  }
}

export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectResult> {
  const parsed = parseValidUrl(url)
  if (!parsed) throw new Error('Invalid URL')

  const cacheKey = `${fetchReaderEnabled() ? 1 : 0}:${url}`
  const cached = urlCache.get(cacheKey)
  if (cached) return cached

  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:'
  }
  let fetchUrl = parsed.toString()
  const arxivNormalized = arxivPaperUrl(fetchUrl)
  if (arxivNormalized !== null) fetchUrl = arxivNormalized

  const structured = await tryStructuredFetch(fetchUrl, abortController.signal)
  if (structured !== null) {
    urlCache.set(cacheKey, structured)
    return structured
  }

  const response: RawResponse | RedirectResult = await fetchPage(fetchUrl, abortController.signal)
  if (response.type === 'redirect') return response

  const rawBytes = Buffer.from(response.data)
  const rawContentType = typeof response.headers['content-type'] === 'string'
    ? response.headers['content-type']
    : ''
  const isPdfMagic = rawBytes.byteLength >= 5 && rawBytes.subarray(0, 5).toString('ascii') === '%PDF-'
  const contentType = isPdfMagic ? 'application/pdf' : rawContentType.toLowerCase()

  if (isBinaryContentType(contentType)) {
    const result = await handleBinaryResponse(rawBytes, contentType, response, abortController.signal)
    urlCache.set(cacheKey, result)
    return result
  }

  const decoded = decodeText(rawBytes, contentType)
  let content = decoded
  let notice: string | undefined
  let cacheable = true

  if (contentType.includes('text/html')) {
    const accessNotice = pageAccessNotice(decoded)
    if (accessNotice !== undefined) {
      throw new FetchRefusedError(response.status, accessNotice)
    }
    const extracted = extractMainHtml(decoded)
    const converter = await getMarkdownConverter()
    content = converter.turndown(extracted.html).trim()
    if (extracted.sparse) {
      const readerResult = await readHostedPage(response.url, abortController.signal)
      notice = readerResult.notice
      if (readerResult.content !== undefined) {
        content = readerResult.content
      } else {
        cacheable = false
      }
    }
  }

  const result: FetchedContent = {
    bytes: rawBytes.byteLength,
    code: response.status,
    codeText: response.statusText,
    content,
    contentType,
    ...(notice !== undefined ? { notice } : {}),
  }
  if (cacheable) urlCache.set(cacheKey, result)
  return result
}

interface FetchSummariseReads {
  utility?: typeof callUtilityModel
  withModel?: typeof callWithModel
  utilityModelId?: () => string
  mainModelId?: () => string
}

function readSummariserReply(
  reply: { isApiErrorMessage?: boolean; message: { content: readonly { readonly type: string }[] } },
): { ok: true; text: string } | { ok: false; reason: string } {
  const text = extractTextContent(reply.message.content, '\n').trim()
  if (reply.isApiErrorMessage) {
    return { ok: false, reason: text || 'API error' }
  }
  if (!text) {
    return { ok: false, reason: 'the reply carried no text' }
  }
  return { ok: true, text }
}

export async function applyPromptToMarkdown(
  prompt: string,
  markdown: string,
  signal: AbortSignal,
  isNonInteractive: boolean,
  isPreapprovedDomain: boolean,
  reads?: FetchSummariseReads,
): Promise<string> {
  if (signal.aborted) throw new AbortError()

  const userPrompt = makeSecondaryModelPrompt(markdown, prompt, isPreapprovedDomain)
  const utility = reads?.utility ?? callUtilityModel
  const withModel = reads?.withModel ?? callWithModel
  const primaryModel = reads?.utilityModelId ? reads.utilityModelId() : utilityCallFor().model
  const mainModel = reads?.mainModelId ? reads.mainModelId() : getEngineModel()

  let primaryReason = ''
  try {
    const reply = await utility({
      systemPrompt: asSystemPrompt([]),
      userPrompt,
      signal,
      options: {
        querySource: 'web_fetch_apply',
        agents: [],
        isNonInteractiveSession: isNonInteractive,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })
    if (signal.aborted) throw new AbortError()
    const outcome = readSummariserReply(reply)
    if (outcome.ok) {
      return `[Model reading of the extracted page, not the page’s own words.]\n\n${outcome.text}`
    }
    primaryReason = outcome.reason
  } catch (error) {
    if (signal.aborted || error instanceof AbortError) throw new AbortError()
    primaryReason = error instanceof Error ? error.message : String(error)
  }

  let roadDetails: string
  if (mainModel !== primaryModel) {
    let fallbackReason = ''
    try {
      const call = utilityCallFor(mainModel, { named: true })
      const reply = await withModel({
        systemPrompt: asSystemPrompt([]),
        userPrompt,
        signal,
        thinkingConfig: call.thinkingConfig,
        options: {
          model: call.model,
          ...(call.effortValue !== undefined ? { effortValue: call.effortValue } : {}),
          effortPinned: call.effortPinned,
          querySource: 'web_fetch_apply',
          agents: [],
          isNonInteractiveSession: isNonInteractive,
          hasAppendSystemPrompt: false,
          mcpTools: [],
        },
      })
      if (signal.aborted) throw new AbortError()
      const outcome = readSummariserReply(reply)
      if (outcome.ok) {
        return `[Model reading of the extracted page, not the page’s own words.]\n\n${outcome.text}`
      }
      fallbackReason = outcome.reason
    } catch (error) {
      if (signal.aborted || error instanceof AbortError) throw new AbortError()
      fallbackReason = error instanceof Error ? error.message : String(error)
    }
    roadDetails = `tried the utility model ${primaryModel} (${primaryReason}), then the session model ${mainModel} (${fallbackReason})`
  } else {
    roadDetails = `tried the utility model ${primaryModel} (${primaryReason}); the session model is the same, so there was no second road`
  }

  const quoteGuard = isPreapprovedDomain
    ? ''
    : ' When quoting from this content, keep every quotation under 125 characters and never reproduce song lyrics verbatim.'
  return `[The page was fetched, but no summariser model was available, so this is the page content itself, not an answer to the prompt.${quoteGuard} Road: ${roadDetails}.]\n\n${markdown}`
}

export { WEB_FETCH_TOOL_NAME }
