import { flagEnv } from '../../substrate/flagRegistry.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { getAttributionHeader } from '../../constants/system.js'
import { getSystemContext } from '../../context.js'
import { buildTurnSystemBlocks } from '../providers/anthropic/cacheAndUsage.js'
import { getPromptCachingEnabled } from '../providers/anthropic/requestParams.js'
import {
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
  roughTokenCountEstimation,
} from '../tokenEstimation.js'
import {
  getAutoCompactThreshold,
  isAutoCompactEnabled,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from '../compact/autoCompact.js'
import { microcompactMessages } from '../compact/microCompact.js'
import type { MCPServerConnection } from '../../utils/mcp/types.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import {
  filterInjectedInstructionFiles,
  getInstructionFiles,
} from '../instructions/engine.js'
import type { Tool, Tools, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { findToolByName, toolMatchesName } from '../../Tool.js'
import { isBuiltInAgent, type AgentDefinition, type AgentDefinitionsResult } from '../../types/agent.js'
import { SkillTool } from '../../tools/SkillTool/SkillTool.js'
import { getSkillToolInfo, getLimitedSkillToolCommands } from '../../tools/SkillTool/prompt.js'
import { isDeferredToolFor, TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import type { Message } from '../../types/message.js'
import type { ApiToolUnion, TextBlockParam } from '../../types/wire.js'
import { appendSystemContext, toolToAPISchema } from '../messages/api.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { awaitContextWindowSource } from './contextWindowWarmup.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { computeFingerprintFromMessages } from '../../utils/fingerprint.js'
import { logError } from '../../utils/log.js'
import { normalizeMessagesForAPI } from '../messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { contextFill, getCurrentUsage } from './tokens.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import { getEngineModel } from '../model/model.js'
import { estimateSkillFrontmatterTokens } from '../../skills/loadSkillsDir.js'
import { isToolSearchEnabled, tellHowToolDefinitionsAreCounted } from '../messages/toolSearch.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


export const TOOL_TOKEN_COUNT_OVERHEAD: Unbuilt = unbuilt('src/services/context/analyzeContext.ts:50')

type SystemPromptSectionDetail = Unbuilt

export type ContextData = Unbuilt

const UNKNOWN_NAME = 'unknown'

type ContextItemSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'extension'
  | 'built-in'


type CountableMessage = { role: 'user' | 'assistant'; content: unknown }

let counterRoadDown = false

function countingApplies(): boolean {
  return declaredRouteOf(getEngineModel()) === 'anthropic'
}

function noteCounterAnsweredNothing(): null {
  if (countingApplies() && !counterRoadDown) {
    counterRoadDown = true
    logForDebugging('analyzeContext: the token counter answered nothing on a route that serves it — the rest of this analysis asks no more', { level: 'warn' })
  }
  return null
}

async function apiCount(messages: CountableMessage[], tools: ApiToolUnion[], system?: readonly TextBlockParam[]): Promise<number | null> {
  if (counterRoadDown) return null
  const count = await countMessagesTokensWithAPI(messages, tools, system)
  return count ?? noteCounterAnsweredNothing()
}

async function countStringTokens(content: string): Promise<number | null> {
  return notBuilt('src/services/context/analyzeContext.ts:186')
}

type GetToolPermissionContext = (...args: Unbuilt[]) => Unbuilt

async function countMessagesInRequest(
  messages: CountableMessage[],
  roster: Tools,
  requestSystem: TextBlockParam[],
  getToolPermissionContext: GetToolPermissionContext,
  agentInfo: AgentDefinitionsResult,
  model: string,
): Promise<number | null> {
  const requestTools = await projectToolSchemas(roster, getToolPermissionContext, agentInfo, model)
  const request = await apiCount(messages, requestTools, requestSystem)
  if (request === null) return null
  const prefix = await apiCount([], requestTools, requestSystem)
  const placeholder = await apiCount([], [])
  if (prefix === null || placeholder === null) return null
  return Math.max(0, request - prefix + placeholder)
}

async function projectToolSchemas(
  tools: readonly Tool[],
  getToolPermissionContext: GetToolPermissionContext,
  agentInfo: AgentDefinitionsResult,
  model?: string,
): Promise<ApiToolUnion[]> {
  return notBuilt('src/services/context/analyzeContext.ts:209')
}

export async function countToolDefinitionTokens(
  tools: readonly Tool[],
  getToolPermissionContext: GetToolPermissionContext,
  agentInfo: AgentDefinitionsResult,
  model?: string,
): Promise<number> {
  return notBuilt('src/services/context/analyzeContext.ts:228')
}


function sectionDisplayName(part: string): string {
  return notBuilt('src/services/context/analyzeContext.ts:346')
}

async function countSystemPrompt(
  runtimeModel: string,
  tools: Tools,
  toolUseContext: Pick<ToolUseContext, 'options'> | undefined,
  mainThreadAgentDefinition: AgentDefinition | undefined,
  messages: Message[],
): Promise<{ tokens: number; sections: SystemPromptSectionDetail[]; requestSystem: TextBlockParam[] }> {
  const options = (toolUseContext as { options?: Record<string, unknown> } | undefined)?.options
  const defaultSystemPrompt = await getSystemPrompt(
    tools,
    runtimeModel,
    options?.mcpClients as MCPServerConnection[] | undefined,
  )
  const { buildEffectiveSystemPrompt } = await import('../../utils/systemPrompt.js')
  const effective = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: mainThreadAgentDefinition as AgentDefinition,
    toolUseContext: toolUseContext ?? ({ options: {} } as Pick<ToolUseContext, 'options'>),
    customSystemPrompt: options?.customSystemPrompt as string | undefined,
    defaultSystemPrompt,
    appendSystemPrompt: options?.appendSystemPrompt as string | undefined,
  })

  const parts = (effective as readonly string[]).filter(part => part !== '')
  const systemContext = await getSystemContext()
  const contextEntries = Object.entries(systemContext).filter(([, value]) => value !== '')
  const requestSystem = buildTurnSystemBlocks(
    getAttributionHeader(computeFingerprintFromMessages(messages)),
    asSystemPrompt(appendSystemContext(effective, systemContext)),
    getPromptCachingEnabled(runtimeModel),
  )
  if (parts.length === 0 && contextEntries.length === 0) {
    return { tokens: 0, sections: [], requestSystem }
  }
  const sections: SystemPromptSectionDetail[] = await Promise.all([
    ...parts.map(async part => ({
      name: sectionDisplayName(part),
      tokens: (await countStringTokens(part)) ?? 0,
    })),
    ...contextEntries.map(async ([key, value]) => ({
      name: key,
      tokens: (await countStringTokens(value)) ?? 0,
    })),
  ])
  const total = sections.reduce((sum, section) => sum + section.tokens, 0)
  return { tokens: total, sections, requestSystem }
}

async function countMemoryFiles(): Promise<{
  tokens: number
  details: Array<{ path: string; type: string; tokens: number }>
}> {
  if (isEnvTruthy(flagEnv('MERCURY_BARE'))) {
    return { tokens: 0, details: [] }
  }
  const own = filterInjectedInstructionFiles(await getInstructionFiles())
  const details: Array<{ path: string; type: string; tokens: number }> = []
  let total = 0
  for (const entry of own) {
    const tokens = (await countStringTokens(entry.content)) ?? 0
    total += tokens
    details.push({ path: entry.path, type: entry.type, tokens })
  }
  return { tokens: total, details }
}


const FREE_SPACE_NAME = 'Free space'

function gridDimensions(contextWindow: number, terminalWidth?: number): { width: number; height: number } {
  const narrow = terminalWidth !== undefined && terminalWidth !== 0 && terminalWidth < 80
  if (contextWindow >= 1_000_000) {
    return narrow ? { width: 5, height: 10 } : { width: 20, height: 10 }
  }
  return narrow ? { width: 5, height: 5 } : { width: 10, height: 10 }
}


function roughBlockTokens(block: unknown, onUnmeasured?: () => void): number {
  try {
    return roughTokenCountEstimation(JSON.stringify(block))
  } catch (error) {
    passedOver(error)
    onUnmeasured?.()
    return 0
  }
}

function computeMessageBreakdown(messages: Message[]): {
  breakdown: NonNullable<ContextData['messageBreakdown']>
  unmeasured: boolean
} {
  const toolCallTokensByName = new Map<string, number>()
  const toolResultTokensByName = new Map<string, number>()
  const attachmentTokensByType = new Map<string, number>()
  let assistantMessageTokens = 0
  let userMessageTokens = 0
  let unmeasured = false
  const markUnmeasured = (): void => {
    unmeasured = true
  }
  const toolNameByUseId = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_use'
      ) {
        const use = block as { id?: string; name?: string }
        if (use.id && use.name) toolNameByUseId.set(use.id, use.name)
      }
    }
  }

  for (const message of messages) {
    if (message.type === 'assistant') {
      const content = message.message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const type = (block as { type?: string }).type
        const tokens = roughBlockTokens(block, markUnmeasured)
        if (type === 'tool_use') {
          const name = (block as { name?: string }).name ?? UNKNOWN_NAME
          toolCallTokensByName.set(name, (toolCallTokensByName.get(name) ?? 0) + tokens)
        } else {
          assistantMessageTokens += tokens
        }
      }
    } else if (message.type === 'user') {
      const content = message.message.content
      if (typeof content === 'string') {
        userMessageTokens += roughBlockTokens(content, markUnmeasured)
        continue
      }
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const type = (block as { type?: string }).type
        const tokens = roughBlockTokens(block, markUnmeasured)
        if (type === 'tool_result') {
          const useId = (block as { tool_use_id?: string }).tool_use_id
          const name = (useId !== undefined && toolNameByUseId.get(useId)) || UNKNOWN_NAME
          toolResultTokensByName.set(name, (toolResultTokensByName.get(name) ?? 0) + tokens)
        } else {
          userMessageTokens += tokens
        }
      }
    } else if (message.type === 'attachment') {
      const attachmentType = (message.attachment as { type?: string }).type ?? UNKNOWN_NAME
      const tokens = roughBlockTokens(message.attachment, markUnmeasured)
      attachmentTokensByType.set(attachmentType, (attachmentTokensByType.get(attachmentType) ?? 0) + tokens)
    }
  }

  const toolNames = new Set<string>([...toolCallTokensByName.keys(), ...toolResultTokensByName.keys()])
  const toolCallsByType = [...toolNames]
    .map(name => ({
      name,
      callTokens: toolCallTokensByName.get(name) ?? 0,
      resultTokens: toolResultTokensByName.get(name) ?? 0,
    }))
    .sort((a, b) => b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens))
  const attachmentsByType = [...attachmentTokensByType.entries()]
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens)

  let toolCallTokens = 0
  for (const tokens of toolCallTokensByName.values()) toolCallTokens += tokens
  let toolResultTokens = 0
  for (const tokens of toolResultTokensByName.values()) toolResultTokens += tokens
  let attachmentTokens = 0
  for (const tokens of attachmentTokensByType.values()) attachmentTokens += tokens

  return {
    breakdown: {
      toolCallTokens,
      toolResultTokens,
      attachmentTokens,
      assistantMessageTokens,
      userMessageTokens,
      toolCallsByType,
      attachmentsByType,
    },
    unmeasured,
  }
}


export async function analyzeContextUsage(
  messages: Message[],
  model: string,
  getToolPermissionContext: GetToolPermissionContext,
  tools: Tools,
  agentDefinitions: AgentDefinitionsResult,
  terminalWidth?: number,
  toolUseContext?: Pick<ToolUseContext, 'options'>,
  mainThreadAgentDefinition?: AgentDefinition,
  originalMessages?: Message[],
): Promise<ContextData> {
  return notBuilt('src/services/context/analyzeContext.ts:620')
}
