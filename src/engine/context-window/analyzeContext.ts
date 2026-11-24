import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getSystemPrompt } from '../system-prompt/defaultSystemPrompt.js'
import { getAttributionHeader } from '../../models/roads/attributionHeader.js'
import { getSystemContext } from '../requestContext.js'
import { buildTurnSystemBlocks } from '../../models/roads/anthropic/cacheAndUsage.js'
import { getPromptCachingEnabled } from '../../models/roads/anthropic/requestParams.js'
import {
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
  roughTokenCountEstimation,
} from '../../models/facts/tokenEstimation.js'
import {
  getAutoFoldThreshold,
  isAutoFoldEnabled,
  MANUAL_FOLD_BUFFER_TOKENS,
} from '../compaction/autoFold.js'
import { pruneMessages } from '../compaction/pruneToolResults.js'
import { getSdkBetas } from '../../boot/process-state/processState.js'
import {
  filterInjectedInstructionFiles,
  getInstructionFiles,
} from '../../sessions/instructions/instructionFiles.js'
import type { Tool, Tools, ToolPermissionContext, ToolUseContext } from '../../tools/kit/tool.js'
import { findToolByName, toolMatchesName } from '../../tools/kit/tool.js'
import { isBuiltInAgent, type AgentDefinition, type AgentDefinitionsResult } from '../../crew/agents/agentDefinition.js'
import { SkillTool } from '../../tools/skill/SkillTool.js'
import { getSkillToolInfo, getLimitedSkillToolCommands } from '../../tools/skill/prompt.js'
import { isDeferredToolFor, TOOL_SEARCH_TOOL_NAME } from '../../tools/tool-search/prompt.js'
import type { Message } from '../message-shapes/message.js'
import type { ApiToolUnion, TextBlockParam } from '../message-shapes/wire.js'
import { appendSystemContext, toolToAPISchema } from '../messages/apiSystemAndToolSchema.js'
import { getContextWindowForModel } from '../compaction-window/contextFill.js'
import { awaitContextWindowSource } from './contextWindowWarmup.js'
import { getCwd } from '../../platform/files/cwd.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import { computeFingerprintFromMessages } from './fingerprint.js'
import { logError } from '../../platform/logs/errorLog.js'
import { normalizeMessagesForAPI } from '../messages/messages.js'
import { asSystemPrompt } from '../system-prompt/systemPromptType.js'
import { contextFill, getCurrentUsage } from './contextTokenCount.js'
import { declaredRouteOf } from '../../models/roads/routeLaw.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { estimateSkillFrontmatterTokens } from '../../integrations/skills/loadSkillsDir.js'
import { isToolSearchEnabled, tellHowToolDefinitionsAreCounted } from '../messages/toolSearch.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { formatCommandsWithinBudgetDetailed } from '../attachments/skillListingFormat.js'
import { buildEffectiveSystemPrompt } from '../system-prompt/systemPrompt.js'
import { zodToJsonSchema } from '../../platform/primitives/zodToJsonSchema.js'


export const TOOL_TOKEN_COUNT_OVERHEAD: number = 500

type SystemPromptSectionDetail = {
  name: string
  tokens: number
}

export type ContextData = {
  categories: Array<{
    name: string
    tokens: number
    color: string
    isDeferred?: boolean
  }>
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  gridRows: Array<
    Array<{
      color: string
      isFilled: boolean
      categoryName: string
      tokens: number
      percentage: number
      squareFullness: number
    }>
  >
  model: string
  memoryFiles: Array<{ path: string; type: string; tokens: number }>
  systemPromptSections?: SystemPromptSectionDetail[]
  systemTools?: Array<{ name: string; tokens: number }>
  deferredBuiltinTools?: Array<{ name: string; tokens: number; isLoaded: boolean }>
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  agents: Array<{ agentType: string; source: ContextItemSource; tokens: number }>
  slashCommands?: {
    totalCommands: number
    includedCommands: number
    tokens: number
  }
  skills?: {
    totalSkills: number
    includedSkills: number
    tokens: number
    skillFrontmatter: Array<{ name: string; source: string; tokens: number }>
    listingTruncation?: {
      budgetChars: number
      nameOnly: number
      withheld: number
    } | null
  }
  isAutoCompactEnabled: boolean
  autoCompactThreshold?: number
  countsAvailable: boolean
  toolDefinitionsUnmeasured?: boolean
  messageBlocksUnmeasured?: boolean
  messageBreakdown?: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: Array<{ name: string; callTokens: number; resultTokens: number }>
    attachmentsByType: Array<{ name: string; tokens: number }>
  }
  apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
}

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

async function countMessagesTokens(
  messages: CountableMessage[],
  tools: ApiToolUnion[],
): Promise<number | null> {
  if (counterRoadDown) return null
  try {
    const count = await countMessagesTokensWithAPI(messages, tools)
    if (count !== null) return count
    logForDebugging('analyzeContext: message token API returned nothing; trying secondary counter')
  } catch (error) {
    logForDebugging('analyzeContext: message token API failed; trying secondary counter')
    logError(error)
  }
  try {
    const fallback = await countTokensViaHaikuFallback(messages, tools)
    if (fallback !== null) return fallback
    logForDebugging('analyzeContext: secondary token counter returned nothing')
  } catch (error) {
    logForDebugging('analyzeContext: secondary token counter failed')
    logError(error)
  }
  return noteCounterAnsweredNothing()
}

async function countStringTokens(content: string): Promise<number | null> {
  return countMessagesTokens([{ role: 'user', content }], [])
}

type GetToolPermissionContext = () => Promise<ToolPermissionContext>

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
  return Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext,
        tools,
        agents: agentInfo.activeAgents,
        allowedAgentTypes: agentInfo.allowedAgentTypes,
        ...(model !== undefined ? { model } : {}),
      }),
    ),
  )
}

export async function countToolDefinitionTokens(
  tools: readonly Tool[],
  getToolPermissionContext: GetToolPermissionContext,
  agentInfo: AgentDefinitionsResult,
  model?: string,
): Promise<number> {
  const schemas = await projectToolSchemas(tools, getToolPermissionContext, agentInfo, model)
  return (await countMessagesTokens([], schemas)) ?? 0
}

tellHowToolDefinitionsAreCounted(countToolDefinitionTokens, TOOL_TOKEN_COUNT_OVERHEAD)

function collectUsedToolNames(messages: readonly Message[]): Set<string> {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block === 'object' && block !== null && block.type === 'tool_use') {
        const name = block.name
        if (typeof name === 'string') names.add(name)
      }
    }
  }
  return names
}

async function measureMcpTools(
  mcpTools: readonly Tool[],
  allTools: Tools,
  messages: Message[],
  model: string,
  getToolPermissionContext: GetToolPermissionContext,
  agentDefinitions: AgentDefinitionsResult,
  usedToolNames: ReadonlySet<string>,
): Promise<{
  mcpToolTokens: number
  mcpToolDetails: ContextData['mcpTools']
  deferredToolTokens: number
  loadedMcpToolNames: Set<string>
  unmeasured: boolean
}> {
  if (mcpTools.length === 0) {
    return {
      mcpToolTokens: 0,
      mcpToolDetails: [],
      deferredToolTokens: 0,
      loadedMcpToolNames: new Set<string>(),
      unmeasured: false,
    }
  }

  const rawTotal = await countToolDefinitionTokens(mcpTools, getToolPermissionContext, agentDefinitions, model)
  const bulkTotal = Math.max(0, rawTotal - TOOL_TOKEN_COUNT_OVERHEAD)

  let unmeasured = false
  const weights = await Promise.all(
    mcpTools.map(async tool => {
      let description = ''
      try {
        description = await tool.prompt({
          getToolPermissionContext,
          tools: allTools,
          agents: agentDefinitions.activeAgents,
          allowedAgentTypes: agentDefinitions.allowedAgentTypes,
        })
      } catch (error) {
        passedOver(error)
      }
      let inputSchema: Record<string, unknown> = {}
      try {
        if (tool.inputJSONSchema !== undefined) {
          inputSchema = tool.inputJSONSchema as Record<string, unknown>
        } else if (tool.inputSchema !== undefined) {
          inputSchema = zodToJsonSchema(tool.inputSchema)
        }
      } catch (error) {
        passedOver(error)
      }
      try {
        return roughTokenCountEstimation(
          JSON.stringify({
            name: tool.name,
            description,
            input_schema: inputSchema,
          }),
        )
      } catch (error) {
        passedOver(error)
        unmeasured = true
        return 0
      }
    }),
  )

  const weightSum = Math.max(
    1,
    weights.reduce((sum, weight) => sum + weight, 0),
  )
  const searchEnabled = await isToolSearchEnabled(
    model,
    allTools,
    getToolPermissionContext,
    agentDefinitions.activeAgents,
  )

  const mcpToolDetails: ContextData['mcpTools'] = []
  const loadedMcpToolNames = new Set<string>()
  for (let index = 0; index < mcpTools.length; index++) {
    const tool = mcpTools[index]!
    const tokens = Math.round((weights[index]! * bulkTotal) / weightSum)
    const parts = tool.name.split('__')
    const serverName = parts[1] || UNKNOWN_NAME
    const isLoaded = usedToolNames.has(tool.name) || !isDeferredToolFor(tool, model, undefined, messages)
    if (isLoaded) loadedMcpToolNames.add(tool.name)
    mcpToolDetails.push({
      name: tool.name,
      serverName,
      tokens,
      isLoaded,
    })
  }

  let mcpToolTokens: number
  let deferredToolTokens: number
  if (searchEnabled) {
    mcpToolTokens = mcpToolDetails
      .filter(detail => detail.isLoaded)
      .reduce((sum, detail) => sum + detail.tokens, 0)
    deferredToolTokens = mcpToolDetails
      .filter(detail => !detail.isLoaded)
      .reduce((sum, detail) => sum + detail.tokens, 0)
  } else {
    mcpToolTokens = bulkTotal
    deferredToolTokens = 0
  }

  return {
    mcpToolTokens,
    mcpToolDetails,
    deferredToolTokens,
    loadedMcpToolNames,
    unmeasured,
  }
}

function sectionDisplayName(part: string): string {
  const heading = /^#+\s+(.+)$/m.exec(part)
  if (heading?.[1]) return heading[1]
  const firstLine = part.split('\n').find(line => line.trim().length > 0) ?? ''
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

async function countSystemPrompt(
  tools: Tools,
  model: string,
  messages: Message[],
  toolUseContext?: Pick<ToolUseContext, 'options'>,
  mainThreadAgentDefinition?: AgentDefinition,
): Promise<{
  tokens: number
  sections: SystemPromptSectionDetail[]
  requestSystem: TextBlockParam[]
}> {
  const options = toolUseContext?.options
  const defaultSystemPrompt = await getSystemPrompt(tools, model, options?.mcpClients)
  const effectiveSystemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition,
    toolUseContext: toolUseContext ?? ({ options: {} } as Pick<ToolUseContext, 'options'>),
    customSystemPrompt: options?.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: options?.appendSystemPrompt,
  })
  const systemContext: Record<string, string> = await getSystemContext()

  const promptParts = effectiveSystemPrompt.filter(part => part !== '')
  const contextEntries = Object.entries(systemContext).filter(([, value]) => value !== '')

  const [promptCounts, contextCounts] = await Promise.all([
    Promise.all(promptParts.map(async part => (await countStringTokens(part)) ?? 0)),
    Promise.all(contextEntries.map(async ([, value]) => (await countStringTokens(value)) ?? 0)),
  ])

  const sections: SystemPromptSectionDetail[] = [
    ...promptParts.map((part, index) => ({
      name: sectionDisplayName(part),
      tokens: promptCounts[index]!,
    })),
    ...contextEntries.map(([key], index) => ({
      name: key,
      tokens: contextCounts[index]!,
    })),
  ]

  const tokens = sections.reduce((sum, section) => sum + section.tokens, 0)
  const attribution = getAttributionHeader(computeFingerprintFromMessages(messages))
  const fullSystemPrompt = asSystemPrompt(appendSystemContext(effectiveSystemPrompt, systemContext, model))
  const requestSystem = buildTurnSystemBlocks(attribution, fullSystemPrompt, getPromptCachingEnabled(model))

  return { tokens, sections, requestSystem }
}
async function countInstructionFiles(): Promise<{
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

type GridSquare = ContextData['gridRows'][number][number]

function buildContextGrid(
  categories: ContextData['categories'],
  contextWindow: number,
  terminalWidth?: number,
): ContextData['gridRows'] {
  const { width, height } = gridDimensions(contextWindow, terminalWidth)
  const totalSquares = width * height
  const safeWindow = contextWindow > 0 ? contextWindow : 1

  let freeCategory: ContextData['categories'][number] | undefined
  let reserveCategory: ContextData['categories'][number] | undefined
  const ordinaryCategories: ContextData['categories'] = []

  for (const category of categories) {
    if (category.isDeferred) continue
    if (category.name === FREE_SPACE_NAME) {
      freeCategory = category
    } else if (category.name === 'Autocompact buffer' || category.name === 'Compact buffer') {
      reserveCategory = category
    } else {
      ordinaryCategories.push(category)
    }
  }

  const squares: GridSquare[] = []

  for (const category of ordinaryCategories) {
    if (squares.length >= totalSquares) break
    const exactSquares = (category.tokens / safeWindow) * totalSquares
    const count = Math.max(1, Math.round(exactSquares))
    const percentage = Math.round((category.tokens / safeWindow) * 100)
    const fractionalIndex = Math.floor(exactSquares)
    const fractionalValue = exactSquares - fractionalIndex
    for (let i = 0; i < count && squares.length < totalSquares; i++) {
      const squareFullness = i === fractionalIndex && fractionalValue > 0 ? fractionalValue : 1
      squares.push({
        color: category.color,
        isFilled: true,
        categoryName: category.name,
        tokens: category.tokens,
        percentage,
        squareFullness,
      })
    }
  }

  const reserveCount =
    reserveCategory && reserveCategory.tokens > 0
      ? Math.max(1, Math.round((reserveCategory.tokens / safeWindow) * totalSquares))
      : 0

  const freeTarget = Math.max(squares.length, totalSquares - reserveCount)
  const freeTokens = freeCategory?.tokens ?? 0
  const freeColor = freeCategory?.color ?? 'promptBorder'
  const freePct = Math.round((freeTokens / safeWindow) * 100)
  while (squares.length < freeTarget && squares.length < totalSquares) {
    squares.push({
      color: freeColor,
      isFilled: true,
      categoryName: FREE_SPACE_NAME,
      tokens: freeTokens,
      percentage: freePct,
      squareFullness: 1,
    })
  }

  if (reserveCategory) {
    const reservePct = Math.round((reserveCategory.tokens / safeWindow) * 100)
    while (squares.length < totalSquares) {
      squares.push({
        color: reserveCategory.color,
        isFilled: true,
        categoryName: reserveCategory.name,
        tokens: reserveCategory.tokens,
        percentage: reservePct,
        squareFullness: 1,
      })
    }
  } else {
    while (squares.length < totalSquares) {
      squares.push({
        color: freeColor,
        isFilled: true,
        categoryName: FREE_SPACE_NAME,
        tokens: freeTokens,
        percentage: freePct,
        squareFullness: 1,
      })
    }
  }

  const gridRows: ContextData['gridRows'] = []
  for (let row = 0; row < height; row++) {
    gridRows.push(squares.slice(row * width, (row + 1) * width))
  }
  return gridRows
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
  counterRoadDown = false
  if (declaredRouteOf(model) !== 'local') {
    await awaitContextWindowSource(model)
  }
  const contextWindow = getContextWindowForModel(model, getSdkBetas())

  const mcRaw = await pruneMessages(messages)
  const microcompactedMessages: Message[] = Array.isArray(mcRaw)
    ? mcRaw
    : mcRaw !== null &&
        typeof mcRaw === 'object' &&
        Array.isArray(mcRaw.messages)
      ? mcRaw.messages
      : messages

  const {
    tokens: systemPromptTokens,
    sections: systemPromptSections,
    requestSystem,
  } = await countSystemPrompt(tools, model, messages, toolUseContext, mainThreadAgentDefinition)

  const { tokens: memoryTokens, details: memoryFileDetails } = await countInstructionFiles()

  const mcpTools = tools.filter(tool => tool.name.startsWith('mcp__'))
  const builtinTools = tools.filter(tool => !tool.name.startsWith('mcp__'))
  const deferredBuiltins = builtinTools.filter(tool => isDeferredToolFor(tool, model, undefined, messages))
  const alwaysLoadedBuiltins = builtinTools.filter(tool => !isDeferredToolFor(tool, model, undefined, messages))
  const toolSearchActive = await isToolSearchEnabled(
    model,
    tools,
    getToolPermissionContext,
    agentDefinitions.activeAgents,
  )
  const usedToolNames = collectUsedToolNames(messages)

  let builtinLoadedTokens =
    alwaysLoadedBuiltins.length === 0
      ? 0
      : await countToolDefinitionTokens(alwaysLoadedBuiltins, getToolPermissionContext, agentDefinitions, model)
  let builtinDeferredTokens = 0
  if (deferredBuiltins.length > 0) {
    if (!toolSearchActive) {
      builtinLoadedTokens += await countToolDefinitionTokens(
        deferredBuiltins,
        getToolPermissionContext,
        agentDefinitions,
        model,
      )
    } else {
      for (const tool of deferredBuiltins) {
        const raw = await countToolDefinitionTokens([tool], getToolPermissionContext, agentDefinitions, model)
        const tokens = Math.max(0, raw - TOOL_TOKEN_COUNT_OVERHEAD)
        if (usedToolNames.has(tool.name)) {
          builtinLoadedTokens += tokens
        } else {
          builtinDeferredTokens += tokens
        }
      }
    }
  }

  const mcpResult = await measureMcpTools(
    mcpTools,
    tools,
    messages,
    model,
    getToolPermissionContext,
    agentDefinitions,
    usedToolNames,
  )

  const agentDetails: ContextData['agents'] = []
  let agentTokens = 0
  for (const agent of agentDefinitions.activeAgents) {
    if (isBuiltInAgent(agent)) continue
    const tokens = (await countStringTokens(`${agent.agentType} ${agent.whenToUse}`)) ?? 0
    agentTokens += tokens
    agentDetails.push({
      agentType: agent.agentType,
      source: agent.source ?? 'built-in',
      tokens,
    })
  }

  const cwd = getCwd()
  const skillToolInfo = await getSkillToolInfo(cwd)
  const skillTool = findToolByName(tools, SkillTool.name)
  const skillToolTokens =
    skillTool !== undefined
      ? await countToolDefinitionTokens([skillTool], getToolPermissionContext, agentDefinitions)
      : 0

  const { breakdown: messageBreakdown, unmeasured: messageBlocksUnmeasured } =
    computeMessageBreakdown(microcompactedMessages)
  const normalizedMessages: CountableMessage[] = normalizeMessagesForAPI(microcompactedMessages).map(
    message => ({
      role: message.message.role,
      content: message.message.content,
    }),
  )
  let messageTokens = 0
  if (normalizedMessages.length > 0) {
    const requestRoster = toolSearchActive
      ? tools
      : tools.filter(tool => !toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME))
    const inRequest = await countMessagesInRequest(
      normalizedMessages,
      requestRoster,
      requestSystem,
      getToolPermissionContext,
      agentDefinitions,
      model,
    )
    if (inRequest !== null) {
      messageTokens = inRequest
    } else {
      messageTokens = (await countMessagesTokens(normalizedMessages, [])) ?? 0
    }
  }

  let skillsData: ContextData['skills'] | undefined
  let skillsTokens = 0
  if (skillTool !== undefined) {
    try {
      const limitedCommands = await getLimitedSkillToolCommands(cwd)
      const skillFrontmatter = limitedCommands.map(cmd => {
        const name = cmd.userFacingName?.() ?? (typeof cmd.name === 'string' ? cmd.name : UNKNOWN_NAME)
        const source = cmd.type === 'prompt' ? (cmd.source ?? 'extension') : 'extension'
        const tokens = estimateSkillFrontmatterTokens(cmd)
        return { name, source, tokens }
      })
      skillsTokens = skillFrontmatter.reduce((sum, item) => sum + item.tokens, 0)
      const { truncation: listingTruncation } = formatCommandsWithinBudgetDetailed(
        limitedCommands,
        contextWindow,
      )
      skillsData = {
        totalSkills: limitedCommands.length,
        includedSkills: limitedCommands.length,
        tokens: skillsTokens,
        skillFrontmatter,
        listingTruncation,
      }
    } catch (error) {
      skillsTokens = 0
      logError(error)
    }
  }

  const systemToolsTokens = Math.max(0, builtinLoadedTokens - skillsTokens)
  const categories: ContextData['categories'] = []
  const addCategory = (name: string, tokens: number, color: string, isDeferred?: true): void => {
    if (tokens > 0) {
      categories.push(isDeferred ? { name, tokens, color, isDeferred } : { name, tokens, color })
    }
  }

  addCategory('System prompt', systemPromptTokens, 'promptBorder')
  addCategory('System tools', systemToolsTokens, 'inactive')
  addCategory('MCP tools', mcpResult.mcpToolTokens, 'cyan_FOR_SUBAGENTS_ONLY')
  addCategory('MCP tools (deferred)', mcpResult.deferredToolTokens, 'inactive', true)
  addCategory('System tools (deferred)', builtinDeferredTokens, 'inactive', true)
  addCategory('Custom agents', agentTokens, 'permission')
  addCategory('Memory files', memoryTokens, 'brand')
  addCategory('Skills', skillsTokens, 'warning')
  addCategory('Messages', messageTokens, 'purple_FOR_SUBAGENTS_ONLY')

  const measuredTokens = categories
    .filter(category => !category.isDeferred)
    .reduce((sum, category) => sum + category.tokens, 0)

  const usageMessages = originalMessages ?? messages
  const apiUsage = getCurrentUsage(usageMessages)
  const fill = contextFill(usageMessages)
  const totalTokens = fill.source === 'usage' ? fill.tokens : measuredTokens

  const unmeasuredTokens = totalTokens - measuredTokens
  if (unmeasuredTokens > 0) {
    categories.push({
      name: 'Unmeasured (recorded usage)',
      tokens: unmeasuredTokens,
      color: 'inactive',
    })
  }

  const layoutUsedTokens = Math.max(measuredTokens, totalTokens)
  const autoCompactOn = isAutoFoldEnabled()
  const autoCompactThreshold = autoCompactOn ? getAutoFoldThreshold(model) : undefined
  const reserveTokens = autoCompactOn
    ? Math.max(0, contextWindow - autoCompactThreshold!)
    : MANUAL_FOLD_BUFFER_TOKENS
  const reserveName = autoCompactOn ? 'Autocompact buffer' : 'Compact buffer'
  categories.push({
    name: reserveName,
    tokens: reserveTokens,
    color: 'inactive',
  })

  const freeSpaceTokens = Math.max(0, contextWindow - layoutUsedTokens - reserveTokens)
  categories.push({
    name: FREE_SPACE_NAME,
    tokens: freeSpaceTokens,
    color: 'promptBorder',
  })

  const countsAvailable = systemPromptTokens > 0 || builtinLoadedTokens > 0 || messageTokens > 0
  const gridRows = buildContextGrid(categories, contextWindow, terminalWidth)
  const percentage = contextWindow > 0 ? Math.round((totalTokens / contextWindow) * 100) : 0

  return {
    categories,
    totalTokens,
    maxTokens: contextWindow,
    rawMaxTokens: contextWindow,
    percentage,
    gridRows,
    model,
    memoryFiles: memoryFileDetails,
    systemPromptSections,
    mcpTools: mcpResult.mcpToolDetails,
    agents: agentDetails,
    isAutoCompactEnabled: autoCompactOn,
    countsAvailable,
    messageBreakdown,
    apiUsage,
    ...(skillToolTokens > 0
      ? {
          slashCommands: {
            totalCommands: skillToolInfo.totalCommands,
            includedCommands: skillToolInfo.includedCommands,
            tokens: skillToolTokens,
          },
        }
      : {}),
    ...(skillsData !== undefined && skillsData.tokens > 0 ? { skills: skillsData } : {}),
    ...(autoCompactThreshold !== undefined ? { autoCompactThreshold } : {}),
    ...(mcpResult.unmeasured ? { toolDefinitionsUnmeasured: true } : {}),
    ...(messageBlocksUnmeasured ? { messageBlocksUnmeasured: true } : {}),
  }
}
