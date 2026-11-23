import { z } from 'zod'

import { buildTool, type ToolDef, type ToolUseContext } from '../kit/tool.js'
import { performWebSearch } from '../engines/web-search/searchDoor.js'
import { mapSearchResult, outputSchema, type Output } from './searchOutput.js'
export type { Output } from './searchOutput.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../kit/toolLimits.js'
import type { WebSearchProgress } from '../kit/toolProgress.js'
import { suggestionForExactCommand } from '../../permissions/rules/shellRuleMatching.js'
import { truncate } from '../../platform/text/format.js'
import { getWebSearchPrompt, SEARCH_QUERY_FIELD, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './rows.js'

const inputSchema = z.strictObject({
  query: z.string().min(2).describe(SEARCH_QUERY_FIELD),
  allowed_domains: z.array(z.string()).optional().describe('Restrict results to these domains'),
  blocked_domains: z.array(z.string()).optional().describe('Exclude these domains'),
})

type Input = z.infer<typeof inputSchema>

export const WebSearchTool = buildTool({
  name: WEB_SEARCH_TOOL_NAME,
  searchHint: 'searches the web for current information',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  inputSchema,
  outputSchema,
  isEnabled() {
    return true
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  userFacingName() {
    return 'Web Search'
  },
  async description(input?: Partial<Input>) {
    return `Mercury wants to search the web for: ${input?.query ?? ''}`
  },
  async prompt() {
    return getWebSearchPrompt()
  },
  getActivityDescription(input?: Partial<Input>) {
    return input?.query
      ? `Searching for ${truncate(input.query, TOOL_SUMMARY_MAX_LENGTH)}`
      : 'Searching the web'
  },
  async validateInput(input: Input) {
    if (!input.query) {
      return { result: false, message: 'Error: Missing query', errorCode: 1 }
    }
    if (input.allowed_domains?.length && input.blocked_domains?.length) {
      return {
        result: false,
        message: 'allowed_domains and blocked_domains exclude each other; pass one of them',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async checkPermissions() {
    return {
      behavior: 'passthrough',
      message: `${WEB_SEARCH_TOOL_NAME} requires permission.`,
      suggestions: suggestionForExactCommand(WEB_SEARCH_TOOL_NAME, ''),
    }
  },
  async call(input, context: ToolUseContext, _canUseTool, _parentMessage, onProgress) {
    const startTime = performance.now()
    const run = await performWebSearch(
      {
        query: input.query,
        ...(input.allowed_domains !== undefined ? { allowedDomains: input.allowed_domains } : {}),
        ...(input.blocked_domains !== undefined ? { blockedDomains: input.blocked_domains } : {}),
        signal: context.abortController.signal,
      },
      {
        context,
        ...(onProgress ? { onProgress } : {}),
      },
    )
    const results: Output['results'] = run.sequence.map(entry =>
      typeof entry === 'string'
        ? entry
        : { tool_use_id: entry.toolUseId, content: entry.hits },
    )
    const durationSeconds = (performance.now() - startTime) / 1000
    return {
      data: {
        query: input.query,
        results,
        durationSeconds,
        via: run.via,
        tier: run.tier,
        ...(run.notes.length > 0 ? { notes: run.notes } : {}),
        ...(run.hint ? { hint: run.hint } : {}),
        ...(run.cached === true ? { cached: true } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return mapSearchResult(output, toolUseID)
  },
  extractSearchText() {
    return ''
  },
  getToolUseSummary,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  renderToolUseQueuedMessage() {
    return null
  },
  renderToolUseRejectedMessage() {
    return null
  },
  renderToolUseErrorMessage() {
    return null
  },
} satisfies ToolDef<typeof inputSchema, Output, WebSearchProgress>)
