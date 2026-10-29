import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { performWebSearch } from '../../services/search/searchDoor.js'
import { mapSearchResult, outputSchema, type Output } from './searchOutput.js'
export type { Output, SearchResult } from './searchOutput.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import type { WebSearchProgress } from '../../types/tools.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { truncate } from '../../utils/format.js'
import { getWebSearchPrompt, PROVIDER_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './UI.js'

export type { WebSearchProgress }

const inputSchema = z.strictObject({
  query: z.string().min(2).describe('The search query to use'),
  allowed_domains: z.array(z.string()).optional().describe('Only include search results from these domains'),
  blocked_domains: z.array(z.string()).optional().describe('Never include search results from these domains'),
})

type Input = z.infer<typeof inputSchema>

async function runSearch(
  input: Input,
  context: ToolUseContext,
  onProgress?: (progress: { toolUseID: string; data: WebSearchProgress }) => void,
): Promise<Output> {
  const started = performance.now()
  const run = await performWebSearch(
    {
      query: input.query,
      ...(input.allowed_domains ? { allowedDomains: input.allowed_domains } : {}),
      ...(input.blocked_domains ? { blockedDomains: input.blocked_domains } : {}),
      signal: context.abortController.signal,
    },
    { context, ...(onProgress ? { onProgress } : {}) },
  )
  const durationSeconds = (performance.now() - started) / 1000
  const results: Output['results'] = run.sequence.map(entry =>
    typeof entry === 'string' ? entry : { tool_use_id: entry.toolUseId, content: entry.hits },
  )
  return {
    query: input.query,
    results,
    durationSeconds,
    via: run.via,
    tier: run.tier,
    ...(run.notes.length > 0 ? { notes: run.notes } : {}),
    ...(run.hint ? { hint: run.hint } : {}),
    ...(run.cached ? { cached: true } : {}),
  }
}

export const WebSearchTool = buildTool({
  name: WEB_SEARCH_TOOL_NAME,
  userFacingName: () => 'Web Search',
  searchHint: 'searches the web for current information',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description(input?: Partial<Input>): Promise<string> {
    return `Mercury wants to search the web for: ${input?.query ?? ''}`
  },
  async prompt(options): Promise<string> {
    return getWebSearchPrompt(options?.tools?.some(tool => tool.name === PROVIDER_SEARCH_TOOL_NAME) ?? true)
  },
  getActivityDescription(input: Partial<Input> | undefined): string {
    if (!input?.query) return 'Searching the web'
    return `Searching for ${truncate(input.query, TOOL_SUMMARY_MAX_LENGTH)}`
  },
  getToolUseSummary,
  async validateInput(input: Input) {

    if (!input.query) {
      return { result: false as const, message: 'Error: Missing query', errorCode: 1 }
    }
    if (input.allowed_domains?.length && input.blocked_domains?.length) {
      return {
        result: false as const,
        message: 'allowed_domains and blocked_domains exclude each other; pass one of them',
        errorCode: 2,
      }
    }
    return { result: true as const }
  },
  async checkPermissions() {
    return {
      behavior: 'passthrough' as const,
      message: `${WEB_SEARCH_TOOL_NAME} requires permission.`,
      suggestions: suggestionForExactCommand(WEB_SEARCH_TOOL_NAME, ''),
    }
  },
  async call(input: Input, context: ToolUseContext, _canUseTool?: unknown, _parentMessage?: unknown, onProgress?: (progress: { toolUseID: string; data: WebSearchProgress }) => void) {
    return { data: await runSearch(input, context, onProgress) }
  },
  mapToolResultToToolResultBlockParam: mapSearchResult,

  extractSearchText(): string {
    return ''
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  renderToolUseQueuedMessage: () => null,
  renderToolUseRejectedMessage: () => null,
  renderToolUseErrorMessage: () => null,
})
