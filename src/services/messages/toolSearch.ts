import memoize from 'lodash-es/memoize.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isUnattendedRun } from '../../utils/cockpit/runtimePosture.js'

import type { Tool, ToolPermissionContext, Tools } from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import { formatDeferredToolLine, isDeferredToolFor, TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import type { AgentDefinition, AgentDefinitionsResult } from '../../types/agent.js'
import type { Message } from '../../types/message.js'
import { getMergedBetas } from '../../utils/betas.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { toolDeferralEnabled } from '../../utils/model/capabilities.js'
import { deferralWireFormFor, type DeferralWireForm } from '../providers/deferralWire.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


type ToolSearchMode = Unbuilt

type DeferredToolsDelta = Unbuilt

export type DeferredToolsDeltaScanContext = Unbuilt

const DEFAULT_AUTO_PERCENT: Unbuilt = unbuilt('src/services/messages/toolSearch.ts:34')

function parseAutoPercentage(value: string): number {
  return notBuilt('src/services/messages/toolSearch.ts:36')
}

export function getToolSearchMode(): ToolSearchMode {
  return notBuilt('src/services/messages/toolSearch.ts:47')
}

function getAutoPercent(): number {
  const value = flagEnv('MERCURY_TOOL_SEARCH')
  if (value === undefined || value === '' || !value.startsWith('auto')) return DEFAULT_AUTO_PERCENT
  return parseAutoPercentage(value)
}

export function modelSupportsToolReference(model: string): boolean {
  return notBuilt('src/services/messages/toolSearch.ts:80')
}

let optimisticDebugEmitted = false

function logOptimisticOnce(reason: string): void {
  if (optimisticDebugEmitted) return
  optimisticDebugEmitted = true
  logForDebugging(`tool search optimistically disabled: ${reason}`)
}

export function isToolSearchEnabledOptimistic(): boolean {
  return notBuilt('src/services/messages/toolSearch.ts:93')
}

export function isToolSearchToolAvailable(tools: readonly { name: string }[]): boolean {
  return notBuilt('src/services/messages/toolSearch.ts:101')
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

export async function isToolSearchEnabled(
  model: string,
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  source?: string,
  wireForm?: DeferralWireForm,
): Promise<boolean> {
  return notBuilt('src/services/messages/toolSearch.ts:164')
}

export function isToolReferenceBlock(obj: unknown): boolean {
  return notBuilt('src/services/messages/toolSearch.ts:207')
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
  return notBuilt('src/services/messages/toolSearch.ts:237')
}

export function getDeferredToolsDelta(
  tools: Tools,
  messages: Message[],
  scanContext?: DeferredToolsDeltaScanContext,
  model?: string,
  deferredNames?: ReadonlySet<string>,
): DeferredToolsDelta | null {
  return notBuilt('src/services/messages/toolSearch.ts:285')
}
