import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { nativeBackendIdFor, nativeSearch } from '../../services/search/nativeSearch.js'
import { nativeSearchFamilyOf } from '../../services/search/searchDoor.js'
import { failureLine, searchBackendLabel, viaLine } from '../../services/search/searchContract.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import type { WebSearchProgress } from '../../types/tools.js'
import { AbortError } from '../../utils/errors.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { truncate } from '../../utils/format.js'
import { getProviderSearchPrompt, PROVIDER_SEARCH_TOOL_NAME } from './prompt.js'
import type { Output } from './WebSearchTool.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './UI.js'

/**
 * The PROVIDER'S OWN web search, as its own tool (the operator's
 * model-chooses law): listed only when the session's main model
 * belongs to a family whose wire carries a native search construct
 * (Anthropic's server tool · the OpenAI Responses hosted web_search), so
 * the model sees BOTH doors — this one and the vendored WebSearch — and
 * chooses per query. The native call runs on the session's own family
 * through the routed seam (services/search/nativeSearch); a failure is one
 * typed line, and the model's fallback is choosing WebSearch — never a
 * silent harness fallthrough, never another family's credential.
 */

const inputSchema = z.strictObject({
  query: z.string().min(2).describe('The search query to use'),
  allowed_domains: z.array(z.string()).optional().describe('Only include search results from these domains'),
  blocked_domains: z.array(z.string()).optional().describe('Never include search results from these domains'),
})

type Input = z.infer<typeof inputSchema>

// The one output shape both search tools share (WebSearchTool owns it —
// downstream readers see identical result grammar from either door).
export const providerSearchOutputSchema = z.object({
  query: z.string().describe('The query that was searched'),
  results: z
    .array(
      z.union([
        z.object({
          tool_use_id: z.string().describe('Id of the search this hit group belongs to'),
          content: z.array(
            z.object({
              title: z.string().describe('Title of the search hit'),
              url: z.string().describe('URL of the search hit'),
              snippet: z.string().optional().describe("The backend's excerpt for the hit, when it carries one"),
            }),
          ),
        }),
        z.string(),
      ]),
    )
    .describe("Search hit groups interleaved with the provider model's commentary"),
  durationSeconds: z.number().describe('Elapsed search time in seconds'),
  via: z.string().optional().describe('The native backend that answered: anthropic-native · openai-native'),
  tier: z.enum(['native', 'keyed', 'keyless']).optional().describe("Always 'native' for this tool"),
  notes: z.array(z.string()).optional(),
})

async function runProviderSearch(
  input: Input,
  context: ToolUseContext,
  onProgress?: (progress: { toolUseID: string; data: WebSearchProgress }) => void,
): Promise<Output> {
  const started = performance.now()
  const mainModel = (context.options.mainLoopModel as string | undefined) || getMainLoopModel()
  const family = nativeSearchFamilyOf(mainModel)
  if (!family) {
    // Listed-then-switched: the session's model moved to a family without a
    // native construct after the roster was built. One honest line; the
    // vendored tool still serves.
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
    // Typed, one line; the model's next move is its own choice (WebSearch).
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
  // Listed exactly when the main model's family carries a native search
  // construct — the model-chooses law: BOTH doors visible there, only the
  // vendored one elsewhere. Live read: a /model switch re-derives the roster.
  isEnabled: () => nativeSearchFamilyOf(getMainLoopModel()) !== undefined,
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
  toAutoClassifierInput(input: Input): string {
    return input.query
  },
  async validateInput(input: Input) {
    if (!input.query) {
      return { result: false as const, message: 'Error: Missing query', errorCode: 1 }
    }
    if (input.allowed_domains?.length && input.blocked_domains?.length) {
      return {
        result: false as const,
        message: 'Error: Cannot specify both allowed_domains and blocked_domains in the same request',
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
    const lines: string[] = [`Web search results for query: "${output.query}"`]
    if (output.via && output.tier) lines.push(`Searched ${viaLine(output.via as never, output.tier as never)}.`)
    lines.push('')
    for (const entry of output.results) {
      if (entry === null || entry === undefined) continue
      if (typeof entry === 'string') {
        lines.push(entry)
      } else if (entry.content.length > 0) {
        lines.push(`Links: ${JSON.stringify(entry.content)}`)
      } else {
        lines.push('No links found.')
      }
      lines.push('')
    }
    lines.push('REMINDER: You MUST include the sources above in your response to the user as markdown hyperlinks.')
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: lines.join('\n').trim() }
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

/** The label the health fact and receipts print for a family's native door. */
export function providerSearchDoorLabel(family: 'anthropic' | 'openai'): string {
  return searchBackendLabel(nativeBackendIdFor(family))
}
