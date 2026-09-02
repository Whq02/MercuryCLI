import { memoize } from 'lodash-es'
import { z } from 'zod'

import { buildTool, findToolByName, getEmptyToolPermissionContext, type Tool, type Tools, type ToolUseContext } from '../../Tool.js'
import { deferralWireFormFor } from '../../services/providers/deferralWire.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { declaredCapability } from '../../utils/capability/contract.js'
import { compileToolCapabilityCard } from '../../utils/capability/manifest.js'
import { logForDebugging } from '../../utils/debug.js'
import { escapeRegExp } from '../../utils/stringUtils.js'
import { isToolSearchEnabledOptimistic } from '../../utils/toolSearch.js'
import { cooccurBoostFor, recordToolDiscovery, toolSearchCooccurEnabled } from './cooccurPrior.js'
import { getPrompt, isDeferredTool, TOOL_SEARCH_TOOL_NAME } from './prompt.js'


export const inputSchema = z.object({
  query: z
    .string()
    .describe(
      'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
    ),
  max_results: z.number().optional().default(5).describe('Maximum number of results to return (default: 5)'),
})

type Input = z.infer<typeof inputSchema>

export const outputSchema = z.object({
  matches: z.array(z.string()),
  query: z.string(),
  total_deferred_tools: z.number(),
  pending_mcp_servers: z.array(z.string()).optional(),
  match_lines: z.array(z.string()).optional(),
})

export type Output = z.infer<typeof outputSchema>

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'with', 'my',
  'me', 'is', 'be', 'by', 'into', 'from', 'as', 'at', 'it', 'this', 'that',
  'these', 'those', 'across', 'where', 'when', 'over', 'up', 'out',
])

const MCP_PREFIX = 'mcp__'

function isMcpToolLike(tool: Tool): boolean {
  return ('isMcp' in tool && (tool as { isMcp?: boolean }).isMcp === true) || tool.name.startsWith(MCP_PREFIX)
}

type NameParts = { parts: string[]; full: string }

function parseNameParts(tool: Tool): NameParts {
  if (tool.name.startsWith(MCP_PREFIX)) {
    const stripped = tool.name.slice(MCP_PREFIX.length).toLowerCase()
    return {
      parts: stripped.split('__').flatMap(section => section.split('_')).filter(Boolean),
      full: stripped.replace(/__/g, ' ').replace(/_/g, ' '),
    }
  }
  const parts = tool.name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[_\s]+/)
    .map(part => part.toLowerCase())
    .filter(Boolean)
  return { parts, full: parts.join(' ') }
}

function wordBoundaryPattern(term: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`)
}

function tokeniseForIntents(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 2 && !STOP_WORDS.has(token))
}

function intentBoost(tool: Tool, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0
  try {
    const intents = declaredCapability(tool)?.intents
    if (!intents || intents.length === 0) return 0
    let best = 0
    for (const intent of intents) {
      const intentTokens = new Set(tokeniseForIntents(intent))
      const shared = queryTokens.filter(token => intentTokens.has(token)).length
      if (shared === 0) continue
      const score = 6 + 4 * (shared / queryTokens.length)
      if (score > best) best = score
    }
    return best
  } catch {
    return 0
  }
}

function probeEnabled(tool: Tool): boolean {
  try {
    if (typeof tool.isEnabled !== 'function') return true
    return tool.isEnabled() !== false
  } catch {
    return true
  }
}

export const getToolDescriptionMemoized = memoize(
  async (toolName: string, tools: Tools): Promise<string> => {
    const tool = findToolByName(tools, toolName)
    if (!tool) return ''
    const description = await tool.prompt({
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools,
      agents: [],
    })
    let card = ''
    try {
      card = compileToolCapabilityCard(tool)
    } catch {
      card = ''
    }
    if (!card) return description
    return description ? `${card}\n\n${description}` : card
  },
  (toolName: string) => toolName,
)

let deferredSetCacheKey: string | undefined

export function maybeInvalidateCache(deferredTools: Tools): void {
  const key = deferredTools
    .map(tool => tool.name)
    .sort()
    .join(',')
  if (key === deferredSetCacheKey) return
  deferredSetCacheKey = key
  getToolDescriptionMemoized.cache.clear?.()
  logForDebugging('tool search: deferred set changed, description cache cleared')
}

export function clearToolSearchDescriptionCache(): void {
  getToolDescriptionMemoized.cache.clear?.()
  deferredSetCacheKey = undefined
}

export async function searchToolsWithKeywords(
  query: string,
  deferredTools: Tools,
  allTools: Tools,
  maxResults: number,
): Promise<string[]> {
  const normalised = query.toLowerCase().trim()

  const exactDeferred = deferredTools.find(tool => tool.name.toLowerCase() === normalised)
  const exact = exactDeferred ?? allTools.find(tool => tool.name.toLowerCase() === normalised)
  if (exact) return [exact.name]

  if (normalised.startsWith(MCP_PREFIX) && normalised.length > MCP_PREFIX.length) {
    const prefixed = deferredTools
      .filter(tool => tool.name.toLowerCase().startsWith(normalised))
      .slice(0, maxResults)
      .map(tool => tool.name)
    if (prefixed.length > 0) return prefixed
  }

  const rawTerms = normalised.split(/\s+/).filter(Boolean)
  const requiredTerms = rawTerms
    .filter(term => term.startsWith('+') && term.length > 1)
    .map(term => term.slice(1))
  const optionalTerms = rawTerms.filter(term => !(term.startsWith('+') && term.length > 1))
  const scoringTerms = requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : rawTerms

  const patterns = new Map<string, RegExp>()
  const patternFor = (term: string): RegExp => {
    let pattern = patterns.get(term)
    if (!pattern) {
      pattern = wordBoundaryPattern(term)
      patterns.set(term, pattern)
    }
    return pattern
  }

  const descriptions = new Map<string, string>()
  const descriptionFor = async (tool: Tool): Promise<string> => {
    let description = descriptions.get(tool.name)
    if (description === undefined) {
      description = (await getToolDescriptionMemoized(tool.name, allTools)).toLowerCase()
      descriptions.set(tool.name, description)
    }
    return description
  }

  const hintFor = (tool: Tool): string => (tool.searchHint ?? '').toLowerCase()

  const matchesRequired = async (tool: Tool, term: string): Promise<boolean> => {
    const { parts } = parseNameParts(tool)
    if (parts.includes(term)) return true
    if (parts.some(part => part.includes(term))) return true
    if (patternFor(term).test(await descriptionFor(tool))) return true
    return patternFor(term).test(hintFor(tool))
  }

  let candidates: Tools = deferredTools
  if (requiredTerms.length > 0) {
    const filtered: Tool[] = []
    for (const tool of deferredTools) {
      let all = true
      for (const term of requiredTerms) {
        if (!(await matchesRequired(tool, term))) {
          all = false
          break
        }
      }
      if (all) filtered.push(tool)
    }
    candidates = filtered
  }

  const queryTokens = [...new Set(tokeniseForIntents(normalised))]

  const scored: Array<{ name: string; score: number; enabled: boolean }> = []
  for (const tool of candidates) {
    const { parts, full } = parseNameParts(tool)
    const mcp = isMcpToolLike(tool)
    const description = await descriptionFor(tool)
    const hint = hintFor(tool)
    let score = 0
    for (const term of scoringTerms) {
      if (parts.includes(term)) score += mcp ? 12 : 10
      else if (parts.some(part => part.includes(term))) score += mcp ? 6 : 5
      else if (score === 0 && full.includes(term)) score += 3
      if (hint && patternFor(term).test(hint)) score += 4
      if (description && patternFor(term).test(description)) score += 2
    }
    score += intentBoost(tool, queryTokens)
    if (score > 0 && toolSearchCooccurEnabled()) score += cooccurBoostFor(tool.name)
    if (score === 0) continue
    scored.push({ name: tool.name, score, enabled: probeEnabled(tool) })
  }

  scored.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return b.score - a.score
  })
  return scored.slice(0, maxResults).map(entry => entry.name)
}

function pendingMcpServerNames(context: ToolUseContext): string[] {
  const clients = context.getAppState().mcp?.clients ?? []
  return clients.filter(client => client.type === 'pending').map(client => String(client.name))
}

const SELECT_FORM = /^select:(.+)$/i

async function runSearch(input: Input, context: ToolUseContext): Promise<Output> {
  const { query, max_results = 5 } = input
  const allTools = context.options.tools ?? []
  const searchPermissionMode = context.getAppState().toolPermissionContext.mode
  const deferredTools = allTools.filter(tool => isDeferredTool(tool, searchPermissionMode))
  maybeInvalidateCache(deferredTools)

  const selection = SELECT_FORM.exec(query)
  if (selection) {
    const requested = selection[1]!
      .split(',')
      .map(name => name.trim())
      .filter(Boolean)
    const found: string[] = []
    const unresolved: string[] = []
    for (const name of requested) {
      const tool = findToolByName(deferredTools, name) ?? findToolByName(allTools, name)
      if (tool) {
        if (!found.includes(tool.name)) found.push(tool.name)
      } else {
        unresolved.push(name)
      }
    }
    if (found.length === 0) {
      logForDebugging(`tool search select failed: no requested tool resolved (${requested.join(', ')})`)
      const pending = pendingMcpServerNames(context)
      return {
        matches: [],
        query,
        total_deferred_tools: deferredTools.length,
        ...(pending.length > 0 ? { pending_mcp_servers: pending } : {}),
      }
    }
    if (unresolved.length > 0) {
      logForDebugging(
        `tool search select partial: selected ${found.join(', ')}; unresolved ${unresolved.join(', ')}`,
      )
    } else {
      logForDebugging(`tool search selected: ${found.join(', ')}`)
    }
    recordToolDiscovery(found)
    return { matches: found, query, total_deferred_tools: deferredTools.length }
  }

  const matches = await searchToolsWithKeywords(query, deferredTools, allTools, max_results)
  logForDebugging(`tool search keyword: ${matches.length} match(es) for "${query}"`)
  recordToolDiscovery(matches)
  if (matches.length === 0) {
    const pending = pendingMcpServerNames(context)
    return {
      matches,
      query,
      total_deferred_tools: deferredTools.length,
      ...(pending.length > 0 ? { pending_mcp_servers: pending } : {}),
    }
  }
  return { matches, query, total_deferred_tools: deferredTools.length, match_lines: matchLinesFor(matches, allTools) }
}

function matchLinesFor(names: string[], allTools: Tools): string[] {
  return names.map(name => {
    const tool = findToolByName(allTools, name)
    const hint = tool?.searchHint?.trim()
    return hint ? `${name} — ${hint}` : name
  })
}

export const ToolSearchTool = buildTool({
  name: TOOL_SEARCH_TOOL_NAME,
  userFacingName: () => '',
  strict: false,
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  isEnabled: () => isToolSearchEnabledOptimistic(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description(): Promise<string> {
    return getPrompt(deferralWireFormFor(getMainLoopModel()).form)
  },
  async prompt(options?: { model?: string }): Promise<string> {
    return getPrompt(deferralWireFormFor(options?.model ?? getMainLoopModel()).form)
  },
  async call(input: Input, context: ToolUseContext) {
    return { data: await runSearch(input, context) }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    if (output.matches.length === 0) {
      let text = 'No matching deferred tools were found.'
      if (output.pending_mcp_servers && output.pending_mcp_servers.length > 0) {
        text += ` MCP servers still connecting: ${output.pending_mcp_servers.join(', ')} — their tools will become available shortly; the search may be retried.`
      }
      return { tool_use_id: toolUseID, type: 'tool_result' as const, content: text }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output.matches.map(name => ({ type: 'tool_reference', tool_name: name })) as never,
    }
  },
  renderToolUseMessage: () => null,
  renderToolUseProgressMessage: () => null,
  renderToolUseQueuedMessage: () => null,
  renderToolUseRejectedMessage: () => null,
  renderToolResultMessage: () => null,
  renderToolUseErrorMessage: () => null,
})
