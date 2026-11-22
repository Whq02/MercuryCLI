import { LRUCache } from 'lru-cache'

import { queryUtility, queryWithModel } from '../../services/providers/anthropic/index.js'
import { getEngineModel } from '../../services/model/model.js'
import { utilityCallFor } from '../../services/model/utilityModel.js'
import { AbortError } from '../../utils/errors.js'
import { isBinaryContentType, persistBinaryContent } from '../../services/mcp/mcpOutputStorage.js'
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
import { recognisePdfPage, renderOcr } from '../../services/ocr.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'
export { EgressBlockedError } from './fetchErrors.js'

type FetchedContent = Unbuilt

export function clearWebFetchCache(): void {
  return notBuilt('src/tools/WebFetchTool/utils.ts:44')
}

export function isPreapprovedUrl(url: string): boolean {
  return notBuilt('src/tools/WebFetchTool/utils.ts:64')
}

export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectResult> {
  return notBuilt('src/tools/WebFetchTool/utils.ts:89')
}

interface FetchSummariseReads {
  utility?: typeof queryUtility
  withModel?: typeof queryWithModel
  utilityModelId?: () => string
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
  return notBuilt('src/tools/WebFetchTool/utils.ts:194')
}

export { WEB_FETCH_TOOL_NAME }
