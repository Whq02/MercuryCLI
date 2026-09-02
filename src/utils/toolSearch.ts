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

export function getToolSearchMode(): ToolSearchMode {
  if (isEnvTruthy('1') && !toolDeferralEnabled()) {
    return 'standard'
  }
  const value = process.env.MERCURY_TOOL_SEARCH
  if (value === undefined || value === '') return 'tst'
  if (value.startsWith('auto')) {
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

export function getAutoToolSearchCharThreshold(model: string): number {
  return Math.floor(getAutoTokenThreshold(model) * 2.5)
}

const DEFAULT_UNSUPPORTED_PATTERNS = ['haiku']

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

export function isToolSearchEnabledOptimistic(): boolean {
  if (getToolSearchMode() === 'standard') {
    logOptimisticOnce('standard mode')
    return false
  }
  return true
}

export function isToolSearchToolAvailable(tools: readonly { name: string }[]): boolean {
  return tools.some(tool => toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME))
}

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
      const agentInfo = { allAgents: agents, activeAgents: agents } as AgentDefinitionsResult
      const total = await countToolDefinitionTokens(deferrableTools, getToolPermissionContext, agentInfo, model)
      if (total === 0) return null
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
        }
      }
    }
  }
  return total
}

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

export function extractDiscoveredToolNames(messages: Message[]): Set<string> {
  const discovered = new Set<string>()
  let fromBoundary = 0
  for (const message of messages) {
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

export function getDeferredToolsDelta(
  tools: Tools,
  messages: Message[],
  scanContext?: DeferredToolsDeltaScanContext,
): DeferredToolsDelta | null {
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
