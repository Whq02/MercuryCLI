import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { performWebSearch } from '../../services/search/searchDoor.js'
import { viaLine, type SearchTier } from '../../services/search/searchContract.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import type { WebSearchProgress } from '../../types/tools.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { truncate } from '../../utils/format.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './UI.js'

export type { WebSearchProgress }

/**
 * Mercury's VENDORED web search: the query goes through the vendored door
 * walk (services/search/searchDoor — a stored Brave/Tavily key, else
 * keyless DuckDuckGo; never a provider account) and comes back as plain
 * hit groups any model reads, with `via` naming the backend that answered.
 * The provider's OWN native search is the separate ProviderSearch tool,
 * listed beside this one for families that have it — the model chooses per
 * query (the operator's model-chooses law).
 */

const inputSchema = z.strictObject({
  query: z.string().min(2).describe('The search query to use'),
  allowed_domains: z.array(z.string()).optional().describe('Only include search results from these domains'),
  blocked_domains: z.array(z.string()).optional().describe('Never include search results from these domains'),
})

type Input = z.infer<typeof inputSchema>

const searchHitSchema = z.object({
  title: z.string().describe('Title of the search hit'),
  url: z.string().describe('URL of the search hit'),
  snippet: z.string().optional().describe("The backend's excerpt for the hit, when it carries one"),
})

const searchResultSchema = z.object({
  tool_use_id: z.string().describe('Id of the search this hit group belongs to'),
  content: z.array(searchHitSchema).describe('Search hits as title, url and optional snippet'),
})

export type SearchResult = z.infer<typeof searchResultSchema>

const outputSchema = z.object({
  query: z.string().describe('The query that was searched'),
  results: z
    .array(z.union([searchResultSchema, z.string()]))
    .describe('Search hit groups (string commentary entries appear only in older native-door results)'),
  durationSeconds: z.number().describe('Elapsed search time in seconds'),
  via: z
    .string()
    .optional()
    .describe('The backend that answered: brave · tavily · duckduckgo · duckduckgo-lite (older persisted results may carry a native id)'),
  tier: z.enum(['native', 'keyed', 'keyless']).optional().describe('The door tier the answer came through'),
  notes: z
    .array(z.string())
    .optional()
    .describe('Doors tried before the one that answered, one honest line each'),
})

export type Output = z.infer<typeof outputSchema>

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
  // Listed for every session: the keyless door needs no account, so a
  // search can always be attempted; a session whose every door is closed
  // gets the typed no-backend line at call time (fail-fast over preflight,
  // per the usability owner's law).
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description(input?: Partial<Input>): Promise<string> {
    return `Mercury wants to search the web for: ${input?.query ?? ''}`
  },
  async prompt(): Promise<string> {
    return getWebSearchPrompt()
  },
  getActivityDescription(input: Partial<Input> | undefined): string {
    if (!input?.query) return 'Searching the web'
    return `Searching for ${truncate(input.query, TOOL_SUMMARY_MAX_LENGTH)}`
  },
  getToolUseSummary,
  toAutoClassifierInput(input: Input): string {
    return input.query
  },
  async validateInput(input: Input) {
    // Zero-length only — a whitespace-only query that passes the schema proceeds.
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
      message: `${WEB_SEARCH_TOOL_NAME} requires permission.`,
      suggestions: suggestionForExactCommand(WEB_SEARCH_TOOL_NAME, ''),
    }
  },
  async call(input: Input, context: ToolUseContext, _canUseTool?: unknown, _parentMessage?: unknown, onProgress?: (progress: { toolUseID: string; data: WebSearchProgress }) => void) {
    return { data: await runSearch(input, context, onProgress) }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const lines: string[] = [`Web search results for query: "${output.query}"`]
    // The door that answered, in the model's view too — so it can tell the
    // user honestly where the hits came from.
    if (output.via && output.tier) lines.push(`Searched ${viaLine(output.via as never, output.tier as SearchTier)}.`)
    for (const note of output.notes ?? []) lines.push(`Note: ${note}`)
    lines.push('')
    for (const entry of output.results) {
      // Null entries appear after JSON round-tripping through compaction.
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
  // Empty on purpose: the rendered result shows only counts, so indexing
  // the string entries would produce phantom matches.
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
