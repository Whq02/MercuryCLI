import memoize from 'lodash-es/memoize.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { isUnattendedRun } from '../../screen/cockpit/runtimePosture.js'

import type { Tool, ToolPermissionContext, Tools } from '../../tools/kit/tool.js'
import { toolMatchesName } from '../../tools/kit/tool.js'
import { formatDeferredToolLine, isDeferredToolFor, TOOL_SEARCH_TOOL_NAME } from '../../tools/tool-search/prompt.js'
import type { AgentDefinition, AgentDefinitionsResult } from '../../crew/agents/agentDefinition.js'
import type { Message } from '../message-shapes/message.js'
import { getMergedBetas } from '../../models/roads/betas.js'
import { getContextWindowForModel } from '../compaction-window/contextFill.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isEnvDefinedFalsy } from '../../platform/environment/envUtils.js'
import { toolDeferralEnabled } from '../../models/facts/capabilities.js'
import { deferralWireFormFor, type DeferralWireForm } from '../../models/roads/deferralWire.js'
import { zodToJsonSchema } from '../../platform/primitives/zodToJsonSchema.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { isRecord } from '../../platform/primitives/isRecord.js'


type ToolSearchMode = 'tst' | 'tst-auto' | 'standard'

type DeferredToolsDelta = {
  addedNames: string[]
  addedLines: string[]
  removedNames: string[]
}

export type DeferredToolsDeltaScanContext = {
  callSite: 'attachments_main' | 'attachments_subagent' | 'compact_full' | 'compact_partial' | 'reactive_compact'
  querySource?: string
  hasPendingMcpServers?: boolean
}

const DEFAULT_AUTO_PERCENT: number = 10

function parseAutoPercentage(value: string): number {
  if (!value.startsWith('auto:')) return DEFAULT_AUTO_PERCENT
  const parsed = parseInt(value.slice(5), 10)
  if (Number.isNaN(parsed)) {
    logForDebugging(`MERCURY_TOOL_SEARCH auto percentage did not parse (${value}); using ${DEFAULT_AUTO_PERCENT}`)
    return DEFAULT_AUTO_PERCENT
  }
  return Math.max(0, Math.min(100, parsed))
}

export function getToolSearchMode(): ToolSearchMode {
  if (!toolDeferralEnabled()) return 'standard'
  const value = flagEnv('MERCURY_TOOL_SEARCH')
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
  const value = flagEnv('MERCURY_TOOL_SEARCH')
  if (value === undefined || value === '' || !value.startsWith('auto')) return DEFAULT_AUTO_PERCENT
  return parseAutoPercentage(value)
}

export function modelSupportsToolReference(model: string): boolean {
  return !model.toLowerCase().includes('haiku')
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

type ToolDefinitionCount = (
  tools: readonly Tool[],
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult,
  model?: string,
) => Promise<number>

let toolDefinitionCount: { count: ToolDefinitionCount; overhead: number } | undefined

export function tellHowToolDefinitionsAreCounted(count: ToolDefinitionCount, overhead: number): void {
  toolDefinitionCount = { count, overhead }
}

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
      const schema = tool.inputSchema
      if (schema !== undefined) {
        try {
          total += JSON.stringify(zodToJsonSchema(schema)).length
        } catch (error) {
          passedOver(error)
        }
      }
    }
  }
  return total
}

const memoizedDeferredToolTokens = memoize(
  async (
    deferrableTools: Tool[],
    getToolPermissionContext: () => Promise<ToolPermissionContext>,
    agents: AgentDefinition[],
    model: string,
  ): Promise<number | null> => {
    if (deferrableTools.length === 0) return 0
    if (toolDefinitionCount === undefined) return null
    try {
      const total = await toolDefinitionCount.count(
        deferrableTools,
        getToolPermissionContext,
        { allAgents: agents, activeAgents: agents },
        model,
      )
      if (total === 0) return null
      return Math.max(0, total - toolDefinitionCount.overhead)
    } catch (error) {
      passedOver(error)
      return null
    }
  },
  (deferrableTools: Tool[]) => deferrableTools.map(tool => tool.name).join(','),
)

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

  const permissionContext = await getToolPermissionContext()
  const deferrableTools = tools.filter(tool => isDeferredToolFor(tool, model, permissionContext.mode))
  const percent = getAutoPercent()
  const contextWindow = getContextWindowForModel(model, getMergedBetas(model))
  const tokenThreshold = Math.floor((contextWindow * percent) / 100)
  const sourceSuffix = source ? ` (${source})` : ''

  const measuredTokens =
    deferrableTools.length === 0
      ? 0
      : toolDefinitionCount === undefined
        ? null
        : await memoizedDeferredToolTokens(deferrableTools, getToolPermissionContext, agents, model)

  if (measuredTokens !== null) {
    const enabled = measuredTokens >= tokenThreshold
    logForDebugging(`tool search auto: ${measuredTokens} tokens vs threshold ${tokenThreshold} (${percent}%) => ${enabled}${sourceSuffix}`)
    return enabled
  }

  const chars = characterHeuristic(deferrableTools)
  const charThreshold = Math.floor(tokenThreshold * 2.5)
  const enabled = chars >= charThreshold
  logForDebugging(`tool search auto (character fallback): ${chars} chars vs threshold ${charThreshold} (${percent}%) => ${enabled}${sourceSuffix}`)
  return enabled
}

export function isToolReferenceBlock(obj: unknown): boolean {
  return typeof obj === 'object' && obj !== null && (obj as { type?: unknown }).type === 'tool_reference'
}

function isNamedToolReferenceBlock(obj: unknown): obj is { type: 'tool_reference'; tool_name: string } {
  return isToolReferenceBlock(obj) && isRecord(obj) && typeof obj.tool_name === 'string'
}

function hostedSearchLoadedNames(items: readonly unknown[]): string[] {
  const names: string[] = []
  const walk = (tools: unknown): void => {
    if (!Array.isArray(tools)) return
    for (const raw of tools) {
      const tool = raw as { type?: unknown; name?: unknown; tools?: unknown } | null
      if (tool === null || typeof tool !== 'object') continue
      if (tool.type === 'namespace') walk(tool.tools)
      else if (typeof tool.name === 'string') names.push(tool.name)
    }
  }
  for (const item of items) {
    const record = item as { type?: unknown; tools?: unknown } | null
    if (record !== null && typeof record === 'object' && record.type === 'tool_search_output') walk(record.tools)
  }
  return names
}

export function extractDiscoveredToolNames(messages: Message[]): Set<string> {
  const discovered = new Set<string>()
  let carriedCount = 0
  for (const message of messages) {
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      const preFold = message.compactMetadata?.preCompactDiscoveredTools
      if (Array.isArray(preFold)) {
        for (const name of preFold) {
          discovered.add(name)
          carriedCount++
        }
      }
      continue
    }
    if (message.type === 'assistant') {
      const items = message.apexProviderTurn?.items
      if (Array.isArray(items)) {
        for (const name of hostedSearchLoadedNames(items)) {
          discovered.add(name)
        }
      }
      continue
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue
        for (const item of block.content) {
          if (isNamedToolReferenceBlock(item)) discovered.add(item.tool_name)
        }
      }
    }
  }
  if (discovered.size > 0) {
    const carriedNote = carriedCount > 0 ? ` (${carriedCount} from compact boundaries)` : ''
    logForDebugging(`tool search: ${discovered.size} discovered tools${carriedNote}`)
  }
  return discovered
}

export function getDeferredToolsDelta(
  tools: Tools,
  messages: Message[],
  scanContext?: DeferredToolsDeltaScanContext,
  model?: string,
  deferredNames?: ReadonlySet<string>,
): DeferredToolsDelta | null {
  const announced = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'attachment' || message.attachment.type !== 'deferred_tools_delta') continue
    for (const name of message.attachment.addedNames ?? []) announced.add(name)
    for (const name of message.attachment.removedNames ?? []) announced.delete(name)
  }

  const loaded = extractDiscoveredToolNames(messages)
  for (const message of messages) {
    if (message.type !== 'assistant' || !Array.isArray(message.message.content)) continue
    for (const block of message.message.content) {
      if (block.type === 'tool_use') loaded.add(block.name)
    }
  }

  const currentPool = new Set(tools.map(tool => tool.name))
  const selectedTools = tools.filter(tool => {
    if (loaded.has(tool.name)) return false
    return deferredNames !== undefined
      ? deferredNames.has(tool.name)
      : isDeferredToolFor(tool, model, undefined, messages)
  })
  const selectedNames = new Set(selectedTools.map(tool => tool.name))

  const addedTools = selectedTools.filter(tool => !announced.has(tool.name))
  const unattended = isUnattendedRun()
  const addedNames = addedTools.map(tool => tool.name).sort()
  const addedLines = addedTools.map(tool => formatDeferredToolLine(tool, unattended, model)).sort()

  const holdMcpRemovals = scanContext?.hasPendingMcpServers === true
  const removedNames: string[] = []
  for (const name of announced) {
    if (currentPool.has(name) || selectedNames.has(name)) continue
    if (holdMcpRemovals && name.startsWith('mcp__')) continue
    removedNames.push(name)
  }
  removedNames.sort()

  if (addedNames.length === 0 && removedNames.length === 0) return null
  return { addedNames, addedLines, removedNames }
}
