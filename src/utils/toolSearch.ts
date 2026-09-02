import memoize from 'lodash-es/memoize.js'

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import type { Tool, ToolPermissionContext, Tools } from '../Tool.js'
import { toolMatchesName } from '../Tool.js'
import { formatDeferredToolLine, isDeferredTool, TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/prompt.js'
import type { AgentDefinition, AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../types/message.js'
import { countToolDefinitionTokens, TOOL_TOKEN_COUNT_OVERHEAD } from './analyzeContext.js'
import { getMergedBetas } from './betas.js'
import { getContextWindowForModel } from './context.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { toolDeferralEnabled } from './model/capabilities.js'
import { deferralWireFormFor, type DeferralWireForm } from '../services/providers/deferralWire.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

/**
 * Decides whether deferrable tools are deferred (announced and discovered
 * through the tool-search tool), and tracks which have been discovered.
 * Deferral is Mercury's own context-assembly decision and applies on EVERY
 * provider route; the wire form a route carries it in (the beta block form
 * or the client-side text form) is the deferralWire owner's per-route
 * capability, read here only where the block form has a model dependency.
 */

export type ToolSearchMode = 'tst' | 'tst-auto' | 'standard'

export type DeferredToolsDelta = {
  addedNames: string[]
  addedLines: string[]
  removedNames: string[]
}

export type DeferredToolsDeltaScanContext = {
  callSite: 'attachments_main' | 'attachments_subagent' | 'compact_full' | 'compact_partial' | 'reactive_compact'
  querySource?: string
}

export { isDeferredToolsDeltaEnabled } from './toolSearchFlags.js'

const DEFAULT_AUTO_PERCENT = 10

/** Clamped 0-100; unset, bare `auto` and an unparseable suffix fall back to the default (with a debug line). */
function parseAutoPercentage(value: string): number {
  const suffix = value.slice('auto'.length)
  if (!suffix.startsWith(':')) return DEFAULT_AUTO_PERCENT
  const parsed = parseInt(suffix.slice(1), 10)
  if (Number.isNaN(parsed)) {
    logForDebugging(`MERCURY_TOOL_SEARCH auto percentage did not parse (${value}); using ${DEFAULT_AUTO_PERCENT}`)
    return DEFAULT_AUTO_PERCENT
  }
  return Math.min(100, Math.max(0, parsed))
}

/**
 * Mode resolution. The build bakes the experimental-betas kill switch ON
 * (the environment-truthiness helper applied to a literal), which forces
 * standard mode; the capability predicate re-opens the ladder behind the
 * registered MERCURY_TOOL_DEFER flag on every route (the wire form is the
 * deferralWire owner's business — a gateway that cannot carry the beta
 * form carries the text form, it never switches deferral off). The
 * degenerate guard shape is oracle-pinned — do not rename it.
 */
export function getToolSearchMode(): ToolSearchMode {
  if (isEnvTruthy('1') && !toolDeferralEnabled()) {
    return 'standard'
  }
  const value = process.env.MERCURY_TOOL_SEARCH
  if (value === undefined || value === '') return 'tst'
  if (value.startsWith('auto')) {
    // The clamp applies BEFORE the mode decision, so an out-of-range N can
    // change the mode: 0 pins always-defer, 100 pins standard.
    const percent = parseAutoPercentage(value)
    if (percent === 0) return 'tst'
    if (percent === 100) return 'standard'
    return 'tst-auto'
  }
  if (isEnvDefinedFalsy(value)) return 'standard'
  return 'tst'
}

function getAutoPercent(): number {
  const value = process.env.MERCURY_TOOL_SEARCH
  if (value === undefined || value === '' || !value.startsWith('auto')) return DEFAULT_AUTO_PERCENT
  return parseAutoPercentage(value)
}

function getAutoTokenThreshold(model: string): number {
  const contextWindow = getContextWindowForModel(model, getMergedBetas(model))
  return Math.floor((contextWindow * getAutoPercent()) / 100)
}

/** The character-heuristic threshold: the token threshold at roughly 2.5 characters per token. */
export function getAutoToolSearchCharThreshold(model: string): number {
  return Math.floor(getAutoTokenThreshold(model) * 2.5)
}

/** Default exclusion list — every model is presumed capable except these name patterns. */
const DEFAULT_UNSUPPORTED_PATTERNS = ['haiku']

/**
 * Exclusion, not allow-listing, so new models work without a code change.
 * The gate can override the pattern list live; a throw while reading it
 * falls back to the default.
 */
export function modelSupportsToolReference(model: string): boolean {
  let patterns = DEFAULT_UNSUPPORTED_PATTERNS
  try {
    const fromGate = getFeatureValue_CACHED_MAY_BE_STALE<string[]>('mercury_tool_search_unsupported_models', [])
    if (Array.isArray(fromGate) && fromGate.length > 0) patterns = fromGate
  } catch {
    patterns = DEFAULT_UNSUPPORTED_PATTERNS
  }
  const lowered = model.toLowerCase()
  return !patterns.some(pattern => lowered.includes(pattern.toLowerCase()))
}

let optimisticDebugEmitted = false

function logOptimisticOnce(reason: string): void {
  if (optimisticDebugEmitted) return
  optimisticDebugEmitted = true
  logForDebugging(`tool search optimistically disabled: ${reason}`)
}

/**
 * The cheap availability check for callers that only need "could deferral
 * apply" (pooling the tool-search tool, preserving tool-reference records).
 * Route-independent: the mode ladder alone decides. A gateway whose
 * pass-through support is uncertain, and every non-Anthropic family, carry
 * deferral in the text form — that is the wire owner's selection, never a
 * reason to switch deferral off.
 */
export function isToolSearchEnabledOptimistic(): boolean {
  if (getToolSearchMode() === 'standard') {
    logOptimisticOnce('standard mode')
    return false
  }
  return true
}

/** Membership through the shared tool-name matcher, never raw equality. */
export function isToolSearchToolAvailable(tools: readonly { name: string }[]): boolean {
  return tools.some(tool => toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME))
}

// The exact-count memo keys ONLY on the joined deferrable tool names, so
// it recomputes when MCP servers connect or disconnect. The model and the
// permission context are deliberately not part of the key (a cheap,
// recorded staleness).
const memoizedDeferredToolTokens = memoize(
  async (
    _cacheKey: string,
    deferrableTools: Tool[],
    getToolPermissionContext: () => Promise<ToolPermissionContext>,
    agents: AgentDefinition[],
    model: string,
  ): Promise<number | null> => {
    if (deferrableTools.length === 0) return 0
    try {
      // The counter consumes the definitions-result shape; the callers hand
      // the ACTIVE agent list, so synthesize the result around it.
      const agentInfo = { allAgents: agents, activeAgents: agents } as AgentDefinitionsResult
      const total = await countToolDefinitionTokens(deferrableTools, getToolPermissionContext, agentInfo, model)
      if (total === 0) return null // the counting API was unavailable
      return Math.max(0, total - TOOL_TOKEN_COUNT_OVERHEAD)
    } catch {
      return null
    }
  },
)

function characterHeuristic(deferrableTools: Tool[]): number {
  let total = 0
  for (const tool of deferrableTools) {
    total += tool.name.length
    const description = (tool as { description?: unknown }).description
    if (typeof description === 'string') total += description.length
    const preRendered = (tool as { inputJSONSchema?: unknown }).inputJSONSchema
    if (preRendered !== undefined) {
      total += JSON.stringify(preRendered).length
    } else {
      const schema = (tool as { inputSchema?: unknown }).inputSchema
      if (schema !== undefined) {
        try {
          total += JSON.stringify(zodToJsonSchema(schema as never)).length
        } catch {
          // No serialisable schema contributes nothing.
        }
      }
    }
  }
  return total
}

/**
 * The definitive check: model support (a BLOCK-form fact — the text form
 * has no model dependency, so it is consulted only where the wire carries
 * the beta block), tool availability, then the mode (with the auto
 * threshold measured exactly when possible and by the character heuristic
 * otherwise; both compare greater-than-or-equal). `wireForm` is the
 * caller's already-resolved form; absent, the wire owner resolves it.
 */
export async function isToolSearchEnabled(
  model: string,
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  source?: string,
  wireForm?: DeferralWireForm,
): Promise<boolean> {
  const form = wireForm ?? deferralWireFormFor(model).form
  if (form === 'block' && !modelSupportsToolReference(model)) {
    logForDebugging(`tool search disabled: model ${model} does not support tool references`)
    return false
  }
  if (!isToolSearchToolAvailable(tools)) {
    logForDebugging('tool search disabled: the tool-search tool is not in the tool list')
    return false
  }
  const mode = getToolSearchMode()
  if (mode === 'tst') return true
  if (mode === 'standard') return false

  // The live permission mode keeps the threshold honest: a mode-exempt tool
  // (ApolloReview in apollo) is loaded on the wire, so it must not count
  // toward the deferred-token budget either.
  const thresholdPermissionMode = (await getToolPermissionContext()).mode
  const deferrableTools = tools.filter(tool => isDeferredTool(tool, thresholdPermissionMode))
  const cacheKey = deferrableTools.map(tool => tool.name).join(',')
  const exactTokens = await memoizedDeferredToolTokens(cacheKey, deferrableTools, getToolPermissionContext, agents, model)
  const suffix = source !== undefined ? ` (${source})` : ''
  if (exactTokens !== null) {
    const threshold = getAutoTokenThreshold(model)
    const enabled = exactTokens >= threshold
    logForDebugging(
      `tool search auto: ${exactTokens} tokens vs threshold ${threshold} (${getAutoPercent()}%) => ${enabled}${suffix}`,
    )
    return enabled
  }
  const chars = characterHeuristic(deferrableTools)
  const charThreshold = getAutoToolSearchCharThreshold(model)
  const enabled = chars >= charThreshold
  logForDebugging(
    `tool search auto (character fallback): ${chars} chars vs threshold ${charThreshold} (${getAutoPercent()}%) => ${enabled}${suffix}`,
  )
  return enabled
}

/** Beta shapes absent from the SDK types need their own guards. */
export function isToolReferenceBlock(obj: unknown): boolean {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as { type?: unknown }).type === 'tool_reference'
  )
}

function isNamedToolReference(obj: unknown): obj is { type: 'tool_reference'; tool_name: string } {
  return isToolReferenceBlock(obj) && typeof (obj as { tool_name?: unknown }).tool_name === 'string'
}

/**
 * The set of tool names already discovered in this conversation. A
 * compact-boundary marker contributes the pre-compaction set snapshotted
 * onto its metadata (compaction replaced the reference-bearing messages
 * with a summary) and nothing else; user messages contribute the
 * tool-reference items inside array-content tool results.
 */
export function extractDiscoveredToolNames(messages: Message[]): Set<string> {
  const discovered = new Set<string>()
  let fromBoundary = 0
  for (const message of messages) {
    // Inline type check — the shared compact-boundary predicate's module
    // imports this one, and importing it back closes a cycle.
    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'compact_boundary'
    ) {
      const carried = (message as { compactMetadata?: { preCompactDiscoveredTools?: string[] } })
        .compactMetadata?.preCompactDiscoveredTools
      if (Array.isArray(carried)) {
        for (const name of carried) {
          discovered.add(name)
          fromBoundary++
        }
      }
      continue
    }
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; content?: unknown }>) {
      if (block.type !== 'tool_result') continue
      if (!Array.isArray(block.content)) continue
      for (const item of block.content) {
        if (isNamedToolReference(item)) discovered.add(item.tool_name)
      }
    }
  }
  if (discovered.size > 0) {
    logForDebugging(
      `tool search: ${discovered.size} discovered tools${fromBoundary > 0 ? ` (${fromBoundary} from compact boundaries)` : ''}`,
    )
  }
  return discovered
}

type DeferredToolsDeltaAttachment = {
  type: 'deferred_tools_delta'
  addedNames: string[]
  removedNames: string[]
}

/**
 * Diffs the current deferrable pool against what prior delta attachments
 * announced. A name that stopped being deferrable but is STILL pooled is
 * loaded directly now — reporting it as removed would tell the model
 * something false, so it silently leaves the announced set.
 */
export function getDeferredToolsDelta(
  tools: Tools,
  messages: Message[],
  scanContext?: DeferredToolsDeltaScanContext,
): DeferredToolsDelta | null {
  // Accepted and unused: the call sites have different expectations about
  // a zero prior count, but nothing is emitted for them in this build.
  void scanContext

  const announced = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'attachment') continue
    const attachment = (message as { attachment?: { type?: string } }).attachment
    if (!attachment || attachment.type !== 'deferred_tools_delta') continue
    const delta = attachment as DeferredToolsDeltaAttachment
    for (const name of delta.addedNames ?? []) announced.add(name)
    for (const name of delta.removedNames ?? []) announced.delete(name)
  }

  const deferrableTools = tools.filter(tool => isDeferredTool(tool))
  const deferrableNames = new Set(deferrableTools.map(tool => tool.name))
  const pooledNames = new Set(tools.map(tool => tool.name))

  const added = deferrableTools.filter(tool => !announced.has(tool.name))
  const removed: string[] = []
  for (const name of announced) {
    if (!deferrableNames.has(name) && !pooledNames.has(name)) removed.push(name)
  }

  if (added.length === 0 && removed.length === 0) return null
  return {
    addedNames: added.map(tool => tool.name).sort(),
    addedLines: added.map(tool => formatDeferredToolLine(tool)).sort(),
    removedNames: removed.sort(),
  }
}
