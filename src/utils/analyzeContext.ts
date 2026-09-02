import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY, getSystemPrompt } from '../constants/prompts.js'
import { getSystemContext } from '../context.js'
import {
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
  roughTokenCountEstimation,
} from '../services/tokenEstimation.js'
import {
  getAutoCompactThreshold,
  isAutoCompactEnabled,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'
import { getSdkBetas } from '../bootstrap/state.js'
import {
  filterInjectedInstructionFiles,
  getInstructionFiles,
} from '../services/instructions/engine.js'
import type { Tool, Tools, ToolPermissionContext, ToolUseContext } from '../Tool.js'
import { findToolByName } from '../Tool.js'
import { isBuiltInAgent, type AgentDefinition, type AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { SkillTool } from '../tools/SkillTool/SkillTool.js'
import { getSkillToolInfo, getLimitedSkillToolCommands } from '../tools/SkillTool/prompt.js'
import { isDeferredTool } from '../tools/ToolSearchTool/prompt.js'
import type { Message } from '../types/message.js'
import { toolToAPISchema } from './api.js'
import { getContextWindowForModel } from './context.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { logError } from './log.js'
import { getRuntimeMainLoopModel } from './model/model.js'
import { normalizeMessagesForAPI } from './messages.js'
import { contextFill, getCurrentUsage } from './tokens.js'
import { estimateSkillFrontmatterTokens } from '../skills/loadSkillsDir.js'
import { isToolSearchEnabled } from './toolSearch.js'


export const TOOL_TOKEN_COUNT_OVERHEAD = 500

export interface DeferredBuiltinTool {
  name: string
  tokens: number
  isLoaded: boolean
}

export interface SystemToolDetail {
  name: string
  tokens: number
}

export interface SystemPromptSectionDetail {
  name: string
  tokens: number
}

type ContextCategory = {
  name: string
  tokens: number
  color: string
  isDeferred?: boolean
}

type GridSquare = {
  color: string
  isFilled: boolean
  categoryName: string
  tokens: number
  percentage: number
  squareFullness: number
}

export interface ContextData {
  categories: ContextCategory[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  gridRows: GridSquare[][]
  model: string
  memoryFiles: Array<{ path: string; type: string; tokens: number }>
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  deferredBuiltinTools?: DeferredBuiltinTool[]
  systemTools?: SystemToolDetail[]
  systemPromptSections?: SystemPromptSectionDetail[]
  agents: Array<{ agentType: string; source: ContextItemSource; tokens: number }>
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number }
  skills?: {
    totalSkills: number
    includedSkills: number
    tokens: number
    skillFrontmatter: Array<{ name: string; source: ContextItemSource; tokens: number }>
    listingTruncation?: { budgetChars: number; nameOnly: number; withheld: number } | null
  }
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
  countsAvailable: boolean
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

async function countMessagesTokens(
  messages: CountableMessage[],
  tools: unknown[],
): Promise<number | null> {
  try {
    const apiCount = await countMessagesTokensWithAPI(messages, tools)
    if (apiCount !== null) return apiCount
    logForDebugging('analyzeContext: message token API returned nothing; trying secondary counter')
  } catch (err) {
    logForDebugging('analyzeContext: message token API failed; trying secondary counter')
    logError(err)
  }
  try {
    const fallback = await countTokensViaHaikuFallback(messages, tools)
    if (fallback !== null) return fallback
    logForDebugging('analyzeContext: secondary token counter returned nothing')
  } catch (err) {
    logForDebugging('analyzeContext: secondary token counter failed')
    logError(err)
  }
  return null
}

async function countStringTokens(content: string): Promise<number | null> {
  return countMessagesTokens([{ role: 'user', content }], [])
}

type GetToolPermissionContext = () => Promise<ToolPermissionContext>

async function projectToolSchemas(
  tools: readonly Tool[],
  getToolPermissionContext: GetToolPermissionContext,
  agentInfo: AgentDefinitionsResult,
  model?: string,
): Promise<unknown[]> {
  return Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext,
        tools: tools as Tools,
        agents: agentInfo.activeAgents,
        allowedAgentTypes: agentInfo.allowedAgentTypes,
        model,
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

export async function countMcpToolTokens(
  tools: readonly Tool[],
  getToolPermissionContext: GetToolPermissionContext,
  agentInfo: AgentDefinitionsResult,
  model: string,
  messages?: Message[],
): Promise<{
  mcpToolTokens: number
  mcpToolDetails: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  deferredToolTokens: number
  loadedMcpToolNames: Set<string>
}> {
  const schemas = await projectToolSchemas(tools, getToolPermissionContext, agentInfo, model)
  const bulkTotal = Math.max(0, ((await countMessagesTokens([], schemas)) ?? 0) - TOOL_TOKEN_COUNT_OVERHEAD)

  const estimates = await Promise.all(
    tools.map(async tool => {
      let description = ''
      try {
        description = await tool.prompt({
          getToolPermissionContext,
          tools: tools as Tools,
          agents: agentInfo.activeAgents,
          allowedAgentTypes: agentInfo.allowedAgentTypes,
        })
      } catch {
        description = ''
      }
      let schema: unknown = {}
      try {
        schema = tool.inputJSONSchema ?? {}
      } catch {
        schema = {}
      }
      try {
        return roughTokenCountEstimation(
          JSON.stringify({ name: tool.name, description, input_schema: schema }),
        )
      } catch {
        return 0
      }
    }),
  )
  const estimateSum = Math.max(
    1,
    estimates.reduce((total, estimate) => total + estimate, 0),
  )

  const deferralOn = await isToolSearchEnabled(model, tools as Tools, getToolPermissionContext, agentInfo.activeAgents)

  const usedNames = new Set<string>()
  if (messages) {
    for (const message of messages) {
      if (message.type !== 'assistant') continue
      const content = message.message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'tool_use' &&
          typeof (block as { name?: unknown }).name === 'string'
        ) {
          usedNames.add((block as { name: string }).name)
        }
      }
    }
  }

  const mcpToolDetails: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }> = []
  const loadedMcpToolNames = new Set<string>()
  let loadedSum = 0
  let deferredSum = 0
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i] as Tool
    const displayTokens = Math.round((bulkTotal * (estimates[i] as number)) / estimateSum)
    const serverName = tool.name.split('__')[1] || UNKNOWN_NAME
    const isLoaded = usedNames.has(tool.name) || !isDeferredTool(tool)
    if (isLoaded) {
      loadedSum += displayTokens
      loadedMcpToolNames.add(tool.name)
    } else if (deferralOn) {
      deferredSum += displayTokens
    }
    mcpToolDetails.push({
      name: tool.name,
      serverName,
      tokens: displayTokens,
      isLoaded,
    })
  }

  return {
    mcpToolTokens: deferralOn ? loadedSum : bulkTotal,
    mcpToolDetails,
    deferredToolTokens: deferralOn ? deferredSum : 0,
    loadedMcpToolNames,
  }
}


function sectionDisplayName(part: string): string {
  const heading = /^#+\s+(.+)$/m.exec(part)
  if (heading?.[1]) return heading[1]
  const firstLine = part.split('\n').find(line => line.trim().length > 0) ?? ''
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

async function countSystemPrompt(
  runtimeModel: string,
  tools: Tools,
  toolUseContext: Pick<ToolUseContext, 'options'> | undefined,
  mainThreadAgentDefinition: AgentDefinition | undefined,
): Promise<{ tokens: number; sections: SystemPromptSectionDetail[] }> {
  const options = (toolUseContext as { options?: Record<string, unknown> } | undefined)?.options
  const defaultSystemPrompt = await getSystemPrompt(tools, runtimeModel)
  const { buildEffectiveSystemPrompt } = await import('./systemPrompt.js')
  const effective = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: mainThreadAgentDefinition as AgentDefinition,
    toolUseContext: toolUseContext ?? ({ options: {} } as Pick<ToolUseContext, 'options'>),
    customSystemPrompt: options?.customSystemPrompt as string | undefined,
    defaultSystemPrompt,
    appendSystemPrompt: options?.appendSystemPrompt as string | undefined,
  })

  const parts = (effective as readonly string[]).filter(
    part => part !== '' && part !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  )
  const systemContext = await getSystemContext()
  const contextEntries = Object.entries(systemContext).filter(([, value]) => value !== '')
  if (parts.length === 0 && contextEntries.length === 0) {
    return { tokens: 0, sections: [] }
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
  return { tokens: total, sections }
}

async function countMemoryFiles(): Promise<{
  tokens: number
  details: Array<{ path: string; type: string; tokens: number }>
}> {
  if (isEnvTruthy(process.env.MERCURY_SIMPLE)) {
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

function buildGrid(
  categories: ContextCategory[],
  contextWindow: number,
  reserveName: string,
  terminalWidth?: number,
): GridSquare[][] {
  const { width, height } = gridDimensions(contextWindow, terminalWidth)
  const totalSquares = width * height

  const squares: GridSquare[] = []
  let reserveSquares: GridSquare[] = []

  const squaresForCategory = (category: ContextCategory): GridSquare[] => {
    const exact = (category.tokens / contextWindow) * totalSquares
    const count = Math.max(1, Math.round(exact))
    const percentage = Math.round((category.tokens / contextWindow) * 100)
    const list: GridSquare[] = []
    for (let i = 0; i < count; i++) {
      list.push({
        color: category.color,
        isFilled: true,
        categoryName: category.name,
        tokens: category.tokens,
        percentage,
        squareFullness: 1,
      })
    }
    const fraction = exact - Math.floor(exact)
    const fractionIndex = Math.floor(exact)
    if (fraction > 0 && fractionIndex < list.length) {
      ;(list[fractionIndex] as GridSquare).squareFullness = fraction
    }
    return list
  }

  let freeSpaceCategory: ContextCategory | null = null
  for (const category of categories) {
    if (category.isDeferred) continue
    if (category.name === FREE_SPACE_NAME) {
      freeSpaceCategory = category
      continue
    }
    if (category.name === reserveName) {
      reserveSquares = squaresForCategory(category)
      continue
    }
    for (const square of squaresForCategory(category)) {
      if (squares.length >= totalSquares) break
      squares.push(square)
    }
  }

  const freeTarget = totalSquares - reserveSquares.length
  const freeTokens = freeSpaceCategory?.tokens ?? 0
  const freePercentage = Math.round((freeTokens / contextWindow) * 100)
  while (squares.length < freeTarget) {
    squares.push({
      color: freeSpaceCategory?.color ?? 'promptBorder',
      isFilled: true,
      categoryName: FREE_SPACE_NAME,
      tokens: freeTokens,
      percentage: freePercentage,
      squareFullness: 1,
    })
  }
  for (const square of reserveSquares) {
    if (squares.length >= totalSquares) break
    squares.push(square)
  }

  const rows: GridSquare[][] = []
  for (let i = 0; i < squares.length; i += width) {
    rows.push(squares.slice(i, i + width))
  }
  return rows
}


function roughBlockTokens(block: unknown): number {
  try {
    return roughTokenCountEstimation(JSON.stringify(block))
  } catch {
    return 0
  }
}

function computeMessageBreakdown(messages: Message[]): NonNullable<ContextData['messageBreakdown']> {
  const toolCallTokensByName = new Map<string, number>()
  const toolResultTokensByName = new Map<string, number>()
  const attachmentTokensByType = new Map<string, number>()
  let assistantMessageTokens = 0
  let userMessageTokens = 0

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
        const tokens = roughBlockTokens(block)
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
        userMessageTokens += roughBlockTokens(content)
        continue
      }
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const type = (block as { type?: string }).type
        const tokens = roughBlockTokens(block)
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
      const tokens = roughBlockTokens(message.attachment)
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
    toolCallTokens,
    toolResultTokens,
    attachmentTokens,
    assistantMessageTokens,
    userMessageTokens,
    toolCallsByType,
    attachmentsByType,
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
  const permissionContext = await getToolPermissionContext()
  const runtimeModel = getRuntimeMainLoopModel({
    mainLoopModel: model,
    permissionMode: permissionContext.mode,
  })
  const contextWindow = getContextWindowForModel(runtimeModel, getSdkBetas())

  const microcompacted = await microcompactMessages(messages, toolUseContext as ToolUseContext | undefined)
  const analysisMessages: Message[] = Array.isArray(microcompacted)
    ? (microcompacted as Message[])
    : ((microcompacted as { messages?: Message[] }).messages ?? messages)

  const systemPromptResult = await countSystemPrompt(
    runtimeModel,
    tools,
    toolUseContext,
    mainThreadAgentDefinition,
  )

  const memoryFiles = await countMemoryFiles()

  const mcpTools = tools.filter(tool => tool.name.startsWith('mcp__'))
  const builtinTools = tools.filter(tool => !tool.name.startsWith('mcp__'))
  const deferredBuiltins = builtinTools.filter(tool => isDeferredTool(tool))
  const loadedBuiltins = builtinTools.filter(tool => !isDeferredTool(tool))
  const agentInfo = agentDefinitions
  const toolSearchEnabled = await isToolSearchEnabled(
    runtimeModel,
    tools,
    getToolPermissionContext,
    agentInfo.activeAgents,
  )

  const alwaysLoadedTokens =
    loadedBuiltins.length === 0
      ? 0
      : await countToolDefinitionTokens(
          loadedBuiltins,
          getToolPermissionContext,
          agentInfo,
          runtimeModel,
        )
  let builtinToolTokens = alwaysLoadedTokens
  let deferredBuiltinTokens = 0
  if (!toolSearchEnabled) {
    if (deferredBuiltins.length > 0) {
      builtinToolTokens += await countToolDefinitionTokens(
        deferredBuiltins,
        getToolPermissionContext,
        agentInfo,
        runtimeModel,
      )
    }
  } else {
    const usedNames = new Set<string>()
    for (const message of messages) {
      if (message.type !== 'assistant') continue
      const content = message.message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'tool_use' &&
          typeof (block as { name?: unknown }).name === 'string'
        ) {
          usedNames.add((block as { name: string }).name)
        }
      }
    }
    for (const tool of deferredBuiltins) {
      const raw = await countToolDefinitionTokens(
        [tool],
        getToolPermissionContext,
        agentInfo,
        runtimeModel,
      )
      const tokens = Math.max(0, raw - TOOL_TOKEN_COUNT_OVERHEAD)
      const isLoaded = usedNames.has(tool.name)
      if (isLoaded) builtinToolTokens += tokens
      else deferredBuiltinTokens += tokens
    }
  }

  const mcpResult = await countMcpToolTokens(
    mcpTools,
    getToolPermissionContext,
    agentInfo,
    runtimeModel,
    messages,
  )

  const customAgents = agentInfo.activeAgents.filter(agent => !isBuiltInAgent(agent))
  const agentDetails: Array<{ agentType: string; source: ContextItemSource; tokens: number }> = []
  let agentTokens = 0
  for (const agent of customAgents) {
    const tokens = (await countStringTokens(`${agent.agentType} ${agent.whenToUse}`)) ?? 0
    agentTokens += tokens
    agentDetails.push({
      agentType: agent.agentType,
      source: (agent as { source?: ContextItemSource }).source ?? 'built-in',
      tokens,
    })
  }

  const skillToolInfo = await getSkillToolInfo(getCwd())
  const skillTool = findToolByName(tools, SkillTool.name)
  let slashCommandTokens = 0
  if (skillTool) {
    slashCommandTokens = await countToolDefinitionTokens(
      [skillTool],
      getToolPermissionContext,
      agentInfo,
    )
  }

  const messageBreakdown = computeMessageBreakdown(analysisMessages)
  const normalizedForCount: CountableMessage[] = normalizeMessagesForAPI(analysisMessages).map(
    message => ({ role: message.message.role, content: message.message.content }),
  )
  const messageTokens =
    normalizedForCount.length > 0 ? ((await countMessagesTokens(normalizedForCount, [])) ?? 0) : 0

  let skillsBlock: ContextData['skills']
  try {
    if (skillTool) {
      const commands = await getLimitedSkillToolCommands(getCwd())
      const skillFrontmatter = commands.map(command => {
        const record = command as unknown as { type?: string; source?: ContextItemSource }
        const name =
          (command as unknown as { userFacingName?: () => string }).userFacingName?.() ??
          String((command as unknown as { name?: string }).name ?? UNKNOWN_NAME)
        return {
          name,
          source: (record.type === 'prompt' ? (record.source ?? 'extension') : 'extension') as ContextItemSource,
          tokens: estimateSkillFrontmatterTokens(command),
        }
      })
      const frontmatterTotal = skillFrontmatter.reduce((total, skill) => total + skill.tokens, 0)
      const { formatCommandsWithinBudgetDetailed } = await import('../tools/SkillTool/prompt.js')
      const listingTruncation = formatCommandsWithinBudgetDetailed(commands, contextWindow).truncation
      skillsBlock = {
        totalSkills: skillFrontmatter.length,
        includedSkills: skillFrontmatter.length,
        tokens: frontmatterTotal,
        skillFrontmatter,
        listingTruncation,
      }
    }
  } catch (err) {
    logError(err)
    skillsBlock = undefined
  }

  const categories: ContextCategory[] = []
  const pushContent = (name: string, tokens: number, color: string, isDeferred?: boolean): void => {
    if (tokens > 0) {
      const category: ContextCategory = { name, tokens, color }
      if (isDeferred) category.isDeferred = true
      categories.push(category)
    }
  }
  pushContent('System prompt', systemPromptResult.tokens, 'promptBorder')
  pushContent('System tools', builtinToolTokens - (skillsBlock?.tokens ?? 0), 'inactive')
  pushContent('MCP tools', mcpResult.mcpToolTokens, 'cyan_FOR_SUBAGENTS_ONLY')
  pushContent('MCP tools (deferred)', mcpResult.deferredToolTokens, 'inactive', true)
  pushContent('System tools (deferred)', deferredBuiltinTokens, 'inactive', true)
  pushContent('Custom agents', agentTokens, 'permission')
  pushContent('Memory files', memoryFiles.tokens, 'brand')
  pushContent('Skills', skillsBlock?.tokens ?? 0, 'warning')
  pushContent('Messages', messageTokens, 'purple_FOR_SUBAGENTS_ONLY')

  const actualUsage = categories
    .filter(category => !category.isDeferred)
    .reduce((total, category) => total + category.tokens, 0)

  const apiUsage = getCurrentUsage(originalMessages ?? messages)
  const fill = contextFill(originalMessages ?? messages)
  const totalTokens = fill.source === 'usage' ? fill.tokens : actualUsage

  const unmeasured = Math.max(0, totalTokens - actualUsage)
  pushContent('Unmeasured (recorded usage)', unmeasured, 'inactive')
  const usedForLayout = Math.max(actualUsage, totalTokens)

  const autoCompactOn = isAutoCompactEnabled()
  let reserveTokens: number
  let reserveName: string
  let autoCompactThreshold: number | undefined
  if (autoCompactOn) {
    autoCompactThreshold = getAutoCompactThreshold(model)
    reserveTokens = contextWindow - autoCompactThreshold
    reserveName = 'Autocompact buffer'
  } else {
    reserveTokens = MANUAL_COMPACT_BUFFER_TOKENS
    reserveName = 'Compact buffer'
  }
  categories.push({ name: reserveName, tokens: reserveTokens, color: 'inactive' })

  const freeSpace = Math.max(0, contextWindow - usedForLayout - reserveTokens)
  categories.push({ name: FREE_SPACE_NAME, tokens: freeSpace, color: 'promptBorder' })

  const gridRows = buildGrid(categories, contextWindow, reserveName, terminalWidth)

  const countsAvailable =
    systemPromptResult.tokens > 0 || builtinToolTokens > 0 || messageTokens > 0

  const result: ContextData = {
    categories,
    totalTokens,
    maxTokens: contextWindow,
    rawMaxTokens: contextWindow,
    percentage: Math.round((totalTokens / contextWindow) * 100),
    gridRows,
    model: runtimeModel,
    memoryFiles: memoryFiles.details,
    systemPromptSections: systemPromptResult.sections,
    mcpTools: mcpResult.mcpToolDetails,
    agents: agentDetails,
    isAutoCompactEnabled: autoCompactOn,
    countsAvailable,
    messageBreakdown,
    apiUsage,
  }
  if (slashCommandTokens > 0) {
    result.slashCommands = {
      totalCommands: skillToolInfo.totalCommands,
      includedCommands: skillToolInfo.includedCommands,
      tokens: slashCommandTokens,
    }
  }
  if (skillsBlock && skillsBlock.tokens > 0) {
    result.skills = skillsBlock
  }
  if (autoCompactThreshold !== undefined) {
    result.autoCompactThreshold = autoCompactThreshold
  }
  return result
}
