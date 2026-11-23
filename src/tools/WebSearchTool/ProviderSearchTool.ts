import { z } from 'zod'

import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { nativeSearch } from '../../services/search/nativeSearch.js'
import { nativeSearchFamilyOf } from '../../services/search/searchDoor.js'
import { failureLine } from '../../services/search/searchContract.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import type { WebSearchProgress } from '../../types/tools.js'
import { AbortError } from '../../utils/errors.js'
import { getEngineModel } from '../../services/model/model.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { truncate } from '../../utils/format.js'
import { getProviderSearchPrompt, PROVIDER_SEARCH_TOOL_NAME } from './prompt.js'
import { mapSearchResult, outputSchema, type Output } from './searchOutput.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './UI.js'

const inputSchema = z.strictObject({
  query: z.string().min(2).describe('Search words'),
  allowed_domains: z.array(z.string()).optional().describe('Restrict results to these domains'),
  blocked_domains: z.array(z.string()).optional().describe('Exclude these domains'),
})

type Input = z.infer<typeof inputSchema>

const providerSearchOutputSchema = outputSchema

export const ProviderSearchTool = buildTool({
  name: PROVIDER_SEARCH_TOOL_NAME,
  searchHint: "searches the web through the session provider's own native search",
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  inputSchema,
  outputSchema: providerSearchOutputSchema,
  isEnabled() {
    return nativeSearchFamilyOf(getEngineModel()) !== undefined
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  userFacingName() {
    return 'Provider Search'
  },
  async description(input?: Partial<Input>) {
    return `Mercury wants to search the web through the provider's own search for: ${input?.query ?? ''}`
  },
  async prompt() {
    return getProviderSearchPrompt()
  },
  getActivityDescription(input?: Partial<Input>) {
    return input?.query
      ? `Searching for ${truncate(input.query, TOOL_SUMMARY_MAX_LENGTH)}`
      : "Searching the web (provider's own search)"
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
      message: `${PROVIDER_SEARCH_TOOL_NAME} requires permission.`,
      suggestions: suggestionForExactCommand(PROVIDER_SEARCH_TOOL_NAME, ''),
    }
  },
  async call(input, context: ToolUseContext, _canUseTool, _parentMessage, onProgress) {
    const startTime = performance.now()
    const model = context.options.engineModel || getEngineModel()
    const family = nativeSearchFamilyOf(model)
    if (!family) {
      throw new Error(
        `ProviderSearch is the provider's own search, and this session's model (${model}) belongs to a family whose wire carries none — use WebSearch (the vendored search) instead.`,
      )
    }
    const outcome = await nativeSearch(
      family,
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
    if (!outcome.ok) {
      if (outcome.kind === 'aborted') throw new AbortError()
      throw new Error(`${failureLine(outcome)} The vendored WebSearch tool is still available.`)
    }
    const results: Output['results'] = (outcome.sequence ?? []).map(entry =>
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
        via: outcome.via,
        tier: outcome.tier,
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
