import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { nativeSearch } from '../../services/search/nativeSearch.js'
import { nativeSearchFamilyOf } from '../../services/search/searchDoor.js'
import { failureLine } from '../../services/search/searchContract.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import type { WebSearchProgress } from '../../types/tools.js'
import { AbortError } from '../../utils/errors.js'
import { getEngineModel } from '../../utils/model/model.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { truncate } from '../../utils/format.js'
import { getProviderSearchPrompt, PROVIDER_SEARCH_TOOL_NAME } from './prompt.js'
import { mapSearchResult, outputSchema, type Output } from './searchOutput.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './UI.js'


const inputSchema = z.strictObject({
  query: z.string().min(2).describe('The search query to use'),
  allowed_domains: z.array(z.string()).optional().describe('Only include search results from these domains'),
  blocked_domains: z.array(z.string()).optional().describe('Never include search results from these domains'),
})

type Input = z.infer<typeof inputSchema>

const providerSearchOutputSchema = outputSchema

async function runProviderSearch(
  input: Input,
  context: ToolUseContext,
  onProgress?: (progress: { toolUseID: string; data: WebSearchProgress }) => void,
): Promise<Output> {
  const started = performance.now()
  const mainModel = (context.options.engineModel as string | undefined) || getEngineModel()
  const family = nativeSearchFamilyOf(mainModel)
  if (!family) {
    throw new Error(
      `${PROVIDER_SEARCH_TOOL_NAME} is the provider's own search, and this session's model (${mainModel}) belongs to a family whose wire carries none — use WebSearch (the vendored search) instead.`,
    )
  }
  const outcome = await nativeSearch(
    family,
    {
      query: input.query,
      ...(input.allowed_domains ? { allowedDomains: input.allowed_domains } : {}),
      ...(input.blocked_domains ? { blockedDomains: input.blocked_domains } : {}),
      signal: context.abortController.signal,
    },
    { context, ...(onProgress ? { onProgress } : {}) },
  )
  if (!outcome.ok) {
    if (outcome.kind === 'aborted') throw new AbortError()
    throw new Error(`${failureLine(outcome)} The vendored WebSearch tool is still available.`)
  }
  const durationSeconds = (performance.now() - started) / 1000
  return {
    query: input.query,
    results: (outcome.sequence ?? []).map(entry =>
      typeof entry === 'string' ? entry : { tool_use_id: entry.toolUseId, content: entry.hits },
    ),
    durationSeconds,
    via: outcome.via,
    tier: outcome.tier,
  }
}

export const ProviderSearchTool = buildTool({
  name: PROVIDER_SEARCH_TOOL_NAME,
  userFacingName: () => 'Provider Search',
  searchHint: "searches the web through the session provider's own native search",
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema: providerSearchOutputSchema,
  isEnabled: () => nativeSearchFamilyOf(getEngineModel()) !== undefined,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description(input?: Partial<Input>): Promise<string> {
    return `Mercury wants to search the web through the provider's own search for: ${input?.query ?? ''}`
  },
  async prompt(): Promise<string> {
    return getProviderSearchPrompt()
  },
  getActivityDescription(input: Partial<Input> | undefined): string {
    if (!input?.query) return "Searching the web (provider's own search)"
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
      message: `${PROVIDER_SEARCH_TOOL_NAME} requires permission.`,
      suggestions: suggestionForExactCommand(PROVIDER_SEARCH_TOOL_NAME, ''),
    }
  },
  async call(input: Input, context: ToolUseContext, _canUseTool?: unknown, _parentMessage?: unknown, onProgress?: (progress: { toolUseID: string; data: WebSearchProgress }) => void) {
    return { data: await runProviderSearch(input, context, onProgress) }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return mapSearchResult(output, toolUseID)
  },
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
