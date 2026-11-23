import { memoize } from 'lodash-es'
import { z } from 'zod'

import {
  buildTool,
  closestToolByName,
  findToolByName,
  getEmptyToolPermissionContext,
  type Tool,
  type Tools,
  type ToolUseContext,
} from '../../Tool.js'
import { deferralWireFormFor } from '../../services/providers/deferralWire.js'
import { getEngineModel } from '../../services/model/model.js'
import { getToolManualAttachments } from '../../services/attachments/toolManuals.js'
import { createAttachmentMessage } from '../../services/attachments/orchestrator.js'
import { declaredCapability } from '../../utils/capability/contract.js'
import { compileToolCapabilityCard } from '../../utils/capability/manifest.js'
import { logForDebugging } from '../../utils/debug.js'
import { escapeRegExp } from '../../utils/stringUtils.js'
import { isToolSearchEnabledOptimistic } from '../../services/messages/toolSearch.js'
import { cooccurBoostFor, recordToolDiscovery, toolSearchCooccurEnabled } from './cooccurPrior.js'
import { getPrompt, isDeferredToolFor, TOOL_SEARCH_TOOL_NAME } from './prompt.js'
import { passedOver } from '../../utils/passedOver.js'

const inputSchema = z.object({
  query: z
    .string()
    .describe(
      'What to load: exact names as "select:<name>,<name>"; or keywords ranked against the deferred roster, where "+word" requires the word (in a tool\'s name, description or search words) and the other words only rank.',
    ),
  max_results: z.number().optional().default(5).describe('Maximum number of results to return (default: 5)'),
})

type Input = z.infer<typeof inputSchema>

const outputSchema = z.object({
  matches: z.array(z.string()),
  query: z.string(),
  total_deferred_tools: z.number(),
  pending_mcp_servers: z.array(z.string()).optional(),
  match_lines: z.array(z.string()).optional(),
  unresolved: z.array(z.string()).optional(),
  resolved: z.array(z.string()).optional(),
  suggestions: z.array(z.string()).optional(),
})

type Output = z.infer<typeof outputSchema>

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

function parseToolName(name: string): NameParts {
  if (name.startsWith(MCP_PREFIX)) {
    const rest = name.slice(MCP_PREFIX.length).toLowerCase()
    const parts = rest.split(/__|_/).filter(Boolean)
    const full = rest.replace(/__/g, ' ').replace(/_/g, ' ')
    return { parts, full }
  }
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[_\s]+/)
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
  } catch (error) {
    passedOver(error)
    return 0
  }
}

function probeEnabled(tool: Tool): boolean {
  try {
    if (typeof tool.isEnabled !== 'function') return true
    return tool.isEnabled() !== false
  } catch (error) {
    logForDebugging(
      `tool search: isEnabled threw for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    return false
  }
}

export const getToolDescriptionMemoized = memoize(
  async (toolName: string, tools: Tools): Promise<string> => {
    const tool = tools.find(t => t.name === toolName)
    if (!tool) return ''
    const prompt = await tool.prompt({
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools,
      agents: [],
    })
    let card = ''
    try {
      card = compileToolCapabilityCard(tool)
    } catch (error) {
      passedOver(error)
    }
    if (card && prompt) return `${card}\n\n${prompt}`
    return card || prompt
  },
  (toolName: string) => toolName,
)

let deferredSetCacheKey: string | null = null

export function maybeInvalidateCache(deferredTools: Tools): void {
  const key = deferredTools
    .map(tool => tool.name)
    .sort()
    .join(',')
  if (key !== deferredSetCacheKey) {
    deferredSetCacheKey = key
    getToolDescriptionMemoized.cache.clear?.()
    logForDebugging('tool search: deferred set changed, description cache cleared')
  }
}

export function clearToolSearchDescriptionCache(): void {
  deferredSetCacheKey = null
  getToolDescriptionMemoized.cache.clear?.()
}

export async function searchToolsWithKeywords(
  query: string,
  deferredTools: Tools,
  allTools: Tools,
  maxResults: number,
): Promise<string[]> {
  const queryLower = query.trim().toLowerCase()
  const exactMatch =
    deferredTools.find(tool => tool.name.toLowerCase() === queryLower) ??
    allTools.find(tool => tool.name.toLowerCase() === queryLower)
  if (exactMatch && queryLower !== 'launch') {
    return [exactMatch.name]
  }
  if (queryLower.startsWith(MCP_PREFIX) && queryLower.length > MCP_PREFIX.length) {
    const prefixMatches = deferredTools
      .filter(tool => tool.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map(tool => tool.name)
    if (prefixMatches.length > 0) return prefixMatches
  }
  maybeInvalidateCache(deferredTools)
  const rawTerms = queryLower.split(/\s+/).filter(Boolean)
  const requiredTerms: string[] = []
  const optionalTerms: string[] = []
  for (const term of rawTerms) {
    if (term.startsWith('+') && term.length > 1) {
      requiredTerms.push(term.slice(1))
    } else {
      optionalTerms.push(term)
    }
  }
  const termsToScore = [...requiredTerms, ...optionalTerms]
  const queryTokens = [...new Set(tokeniseForIntents(queryLower))]
  const cooccurActive = toolSearchCooccurEnabled()
  const scored: Array<{ name: string; score: number; enabled: boolean; index: number }> = []
  for (let index = 0; index < deferredTools.length; index++) {
    const tool = deferredTools[index]!
    const nameParts = parseToolName(tool.name)
    const isMcp = isMcpToolLike(tool)
    const hintLower = (tool.searchHint ?? '').toLowerCase()
    const keywordsLower = (tool.searchKeywords ?? []).map(keyword => keyword.toLowerCase())
    const descriptionLower = (await getToolDescriptionMemoized(tool.name, allTools)).toLowerCase()
    let requiredOk = true
    for (const req of requiredTerms) {
      const inName = nameParts.parts.some(part => part.includes(req))
      if (inName) continue
      const pattern = wordBoundaryPattern(req)
      const inHintOrKeyword =
        (hintLower.length > 0 && pattern.test(hintLower)) ||
        keywordsLower.some(keyword => pattern.test(keyword))
      if (inHintOrKeyword) continue
      if (descriptionLower.length > 0 && pattern.test(descriptionLower)) continue
      requiredOk = false
      break
    }
    if (!requiredOk) continue
    let score = 0
    for (const term of termsToScore) {
      if (nameParts.parts.some(part => part === term)) {
        score += isMcp ? 12 : 10
      } else if (nameParts.parts.some(part => part.includes(term))) {
        score += isMcp ? 6 : 5
      } else if (score === 0 && nameParts.full.includes(term)) {
        score += 3
      }
      const pattern = wordBoundaryPattern(term)
      if (
        (hintLower.length > 0 && pattern.test(hintLower)) ||
        keywordsLower.some(keyword => pattern.test(keyword))
      ) {
        score += 4
      }
      if (descriptionLower.length > 0 && pattern.test(descriptionLower)) {
        score += 2
      }
    }
    score += intentBoost(tool, queryTokens)
    if (score > 0 && cooccurActive) {
      score += cooccurBoostFor(tool.name)
    }
    if (score > 0) {
      scored.push({ name: tool.name, score, enabled: probeEnabled(tool), index })
    }
  }
  scored.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    return a.index - b.index
  })
  const ranked = scored.map(item => item.name)
  if (exactMatch) {
    return [exactMatch.name, ...ranked.filter(name => name !== exactMatch.name)].slice(0, maxResults)
  }
  return ranked.slice(0, maxResults)
}

function pendingMcpServerNames(context: ToolUseContext): string[] {
  const clients = context.getAppState().mcp?.clients ?? []
  return clients.filter(client => client.type === 'pending').map(client => String(client.name))
}

const SELECT_FORM = /^select:(.+)$/i

const quoted = (name: string): string => `"${name}"`

function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

function selectMissText(output: Output): string {
  const misses = output.unresolved ?? []
  const head = `Nothing was loaded: this session has no tool named ${orList(misses.map(quoted))}.`
  const suggestions = output.suggestions
  if (suggestions === undefined || suggestions.length !== misses.length) {
    return `${head} Retry with the names as the "Deferred tools:" list spells them.`
  }
  const retry = [...(output.resolved ?? []), ...suggestions].join(',')
  return `${head} Did you mean ${orList(suggestions.map(quoted))}? Retry with the names as the "Deferred tools:" list spells them: "select:${retry}".`
}

function noMatchText(query: string): string {
  return `No deferred tool matches "${query}"; nothing was loaded. Every tool you can load is in the "Deferred tools:" list with what it is for — pick one there and load it with "select:<name>".`
}

function matchLinesFor(names: string[], allTools: Tools): string[] {
  return names.map(name => {
    const tool = findToolByName(allTools, name)
    const hint = tool?.searchHint?.trim()
    return hint ? `${name} — ${hint}` : name
  })
}

async function runSearch(input: Input, context: ToolUseContext): Promise<Output> {
  const allTools = context.options?.tools ?? []
  const model = context.options?.engineModel ?? getEngineModel()
  const permissionMode = context.getAppState()?.toolPermissionContext?.mode
  const messages = context.messages ?? []
  const deferredTools = allTools.filter(tool => isDeferredToolFor(tool, model, permissionMode, messages))
  const totalDeferred = deferredTools.length
  const selectMatch = SELECT_FORM.exec(input.query)
  if (selectMatch !== null) {
    const requested = selectMatch[1]!
      .split(',')
      .map(name => name.trim())
      .filter(Boolean)
    const resolved: string[] = []
    const seenResolved = new Set<string>()
    const unresolved: string[] = []
    for (const name of requested) {
      const found = findToolByName(deferredTools, name) ?? findToolByName(allTools, name)
      if (found) {
        if (!seenResolved.has(found.name)) {
          seenResolved.add(found.name)
          resolved.push(found.name)
        }
      } else {
        unresolved.push(name)
      }
    }
    if (unresolved.length > 0) {
      const closest = unresolved.map(name => closestToolByName(allTools, name)?.name)
      const suggestions = closest.every((name): name is string => name !== undefined) ? closest : undefined
      const pending = pendingMcpServerNames(context)
      logForDebugging(
        resolved.length > 0
          ? `tool search select loaded nothing: unresolved ${unresolved.join(', ')}; resolved but not loaded ${resolved.join(', ')}`
          : `tool search select loaded nothing: unresolved ${unresolved.join(', ')}`,
      )
      return {
        matches: [],
        query: input.query,
        total_deferred_tools: totalDeferred,
        unresolved,
        ...(resolved.length > 0 ? { resolved } : {}),
        ...(suggestions !== undefined ? { suggestions } : {}),
        ...(pending.length > 0 ? { pending_mcp_servers: pending } : {}),
      }
    }
    if (resolved.length === 0) {
      const pending = pendingMcpServerNames(context)
      logForDebugging(`tool search select failed: no tool requested (${input.query})`)
      return {
        matches: [],
        query: input.query,
        total_deferred_tools: totalDeferred,
        ...(pending.length > 0 ? { pending_mcp_servers: pending } : {}),
      }
    }
    recordToolDiscovery(resolved)
    logForDebugging(`tool search selected: ${resolved.join(', ')}`)
    return {
      matches: resolved,
      query: input.query,
      total_deferred_tools: totalDeferred,
    }
  }
  const maxResults = input.max_results ?? 5
  const matches = await searchToolsWithKeywords(input.query, deferredTools, allTools, maxResults)
  recordToolDiscovery(matches)
  logForDebugging(`tool search keyword: ${matches.length} match(es) for "${input.query}"`)
  if (matches.length === 0) {
    const pending = pendingMcpServerNames(context)
    return {
      matches: [],
      query: input.query,
      total_deferred_tools: totalDeferred,
      ...(pending.length > 0 ? { pending_mcp_servers: pending } : {}),
    }
  }
  return {
    matches,
    query: input.query,
    total_deferred_tools: totalDeferred,
    match_lines: matchLinesFor(matches, allTools),
  }
}

export const ToolSearchTool = buildTool({
  name: TOOL_SEARCH_TOOL_NAME,
  userFacingName: () => '',
  strict: false,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 100_000,
  isEnabled: () => isToolSearchEnabledOptimistic(),
  inputSchema,
  outputSchema,
  async description() {
    return getPrompt(deferralWireFormFor(getEngineModel()).form)
  },
  async prompt(options) {
    return getPrompt(deferralWireFormFor(options?.model ?? getEngineModel()).form)
  },
  async call(input: Input, context: ToolUseContext) {
    const data = await runSearch(input, context)
    const attachments = await getToolManualAttachments(context, data.matches)
    if (attachments.length === 0) return { data }
    return {
      data,
      newMessages: attachments.map(attachment => createAttachmentMessage(attachment)),
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    if (output.matches.length > 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: output.matches.map(tool_name => ({
          type: 'tool_reference' as const,
          tool_name,
        })),
      }
    }
    const base =
      output.unresolved !== undefined && output.unresolved.length > 0
        ? selectMissText(output)
        : noMatchText(output.query)
    const pending = output.pending_mcp_servers
    const suffix =
      pending && pending.length > 0
        ? ` MCP servers still connecting: ${pending.join(', ')} — their tools will become available shortly; the search may be retried.`
        : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `${base}${suffix}`,
    }
  },
  renderToolUseMessage: () => null,
  renderToolUseProgressMessage: () => null,
  renderToolUseQueuedMessage: () => null,
  renderToolUseRejectedMessage: () => null,
  renderToolUseErrorMessage: () => null,
  renderToolResultMessage: () => null,
})
