import { memoize } from 'lodash-es'
import { z } from 'zod'

import { buildTool, closestToolByName, findToolByName, getEmptyToolPermissionContext, type Tool, type Tools, type ToolUseContext } from '../../Tool.js'
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
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


const inputSchema = z.object({
  query: z
    .string()
    .describe(
      'What to load: exact names as "select:<name>,<name>"; or keywords ranked against the deferred roster, where "+word" requires the word (in a tool\'s name, description or search words) and the other words only rank.',
    ),
  max_results: z.number().optional().default(5).describe('Maximum number of results to return (default: 5)'),
})

type Input = z.infer<typeof inputSchema>

const outputSchema: Unbuilt = unbuilt('src/tools/ToolSearchTool/ToolSearchTool.ts:30')

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

export const getToolDescriptionMemoized: Unbuilt = unbuilt('src/tools/ToolSearchTool/ToolSearchTool.ts:117')

export function maybeInvalidateCache(deferredTools: Tools): void {
  return notBuilt('src/tools/ToolSearchTool/ToolSearchTool.ts:140')
}

export function clearToolSearchDescriptionCache(): void {
  return notBuilt('src/tools/ToolSearchTool/ToolSearchTool.ts:151')
}

export async function searchToolsWithKeywords(
  query: string,
  deferredTools: Tools,
  allTools: Tools,
  maxResults: number,
): Promise<string[]> {
  return notBuilt('src/tools/ToolSearchTool/ToolSearchTool.ts:156')
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

export const ToolSearchTool: Unbuilt = unbuilt('src/tools/ToolSearchTool/ToolSearchTool.ts:367')
