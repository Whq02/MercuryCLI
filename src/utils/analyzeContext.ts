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

/**
 * Context-window analysis: one structure describing everything occupying
 * the model context window — categories, grid, per-item details, totals.
 */

/**
 * The counting API adds a fixed tool preamble once per call, so counting N
 * tools individually would multiply it; it is subtracted wherever tools are
 * counted one at a time.
 */
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
    /** The listing-budget degradation record (FN-013 MCP-05): how many
     *  model-facing entries lack descriptions (name-only) and how many
     *  names were withheld entirely; null when nothing degraded. */
    listingTruncation?: { budgetChars: number; nameOnly: number; withheld: number } | null
  }
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
  /** False when the token-counting chain answered nothing (both counters
   *  failed — e.g. no Anthropic credential on a non-Anthropic source): the
   *  per-category sizes are then unmeasured zeros, and the display says so
   *  instead of presenting them as facts. The TOTAL stays honest either
   *  way — it prefers the transcript's own recorded API usage. */
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

// The same marker the message breakdown uses for an unresolvable tool name;
// both reach the display.
const UNKNOWN_NAME = 'unknown'

// Where a context item came from, as the visualization groups it.
type ContextItemSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'extension'
  | 'built-in'

// ---------------------------------------------------------------------------
// Counting fallback chain: the message-shaped token-counting API first; on
// nothing/throw, the token-estimation service's secondary counting API; on
// that failing too, null — with both failures logged. Analysis never throws
// because of counting.
// ---------------------------------------------------------------------------

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

/**
 * Per-string counts (system prompt sections, system-context values, memory
 * files, agents) go through the MESSAGE counter as one user message — the
 * raw-string endpoint is not part of this chain.
 */
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

/**
 * Bulk token count of a tool set's projected schemas. No empty-set early
 * return here: the generic counter issues its call even for an empty set —
 * callers that must not issue on empty (the built-in lane) guard themselves.
 */
export async function countToolDefinitionTokens(
  tools: readonly Tool[],
  getToolPermissionContext: GetToolPermissionContext,
  agentInfo: AgentDefinitionsResult,
  model?: string,
): Promise<number> {
  const schemas = await projectToolSchemas(tools, getToolPermissionContext, agentInfo, model)
  return (await countMessagesTokens([], schemas)) ?? 0
}

/**
 * MCP tool counting: one bulk call for all MCP tools (issued even with an
 * empty tool list — the request is observable and must not be optimised
 * away), minus one per-call overhead, floored at zero. Per-tool display
 * values are apportioned from that total in proportion to a local rough
 * estimate of each tool's serialized name/description/schema — the
 * description must be included, otherwise MCP tools sharing a base input
 * schema get identical counts.
 */
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
    // Display rule: the second `__`-delimited segment of the name, else the
    // literal fallback — no prefix requirement.
    const serverName = tool.name.split('__')[1] || UNKNOWN_NAME
    const isLoaded = usedNames.has(tool.name) || !isDeferredTool(tool)
    if (isLoaded) {
      loadedSum += displayTokens
      loadedMcpToolNames.add(tool.name)
    } else if (deferralOn) {
      deferredSum += displayTokens
    }
    // isLoaded rides every detail row (used-or-not-deferred), with or
    // without deferral.
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

// ---------------------------------------------------------------------------
// Per-source counters
// ---------------------------------------------------------------------------

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
  // FN-017 R3: the options ride through UNCOERCED. An absent custom prompt
  // used to be handed over as '', which the composer's custom slot accepts
  // as a replacement — so every default session's "System prompt" row
  // counted the identity floor alone, tens of thousands of characters
  // short of the prompt the request path composes, and free space was
  // overstated by the difference. The request path passes the values
  // through; this diagnostic must compose exactly what it composes.
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
  // Section counts are issued concurrently; the sections keep their order
  // (prompt parts first, then system-context entries).
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
  // Simple mode disables project-instruction loading; reporting tokens for
  // them would be a lie.
  if (isEnvTruthy(process.env.MERCURY_SIMPLE)) {
    return { tokens: 0, details: [] }
  }
  // The instruction engine's own injected-file filter decides what is
  // actually in context (recall-state-dependent and type-based) — never a
  // local approximation.
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

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

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

  // Free space is NOT sized from its own token count: filler squares are
  // appended until the grid holds totalSquares − reservedSquares, which is
  // what guarantees the grid is exactly full despite category rounding.
  const freeTarget = totalSquares - reserveSquares.length
  const freeTokens = freeSpaceCategory?.tokens ?? 0
  const freePercentage = Math.round((freeTokens / contextWindow) * 100)
  while (squares.length < freeTarget) {
    squares.push({
      color: freeSpaceCategory?.color ?? 'promptBorder',
      // Free-space filler squares carry isFilled: true like every other
      // square; the renderer distinguishes them by category, not the flag.
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

// ---------------------------------------------------------------------------
// Message breakdown
// ---------------------------------------------------------------------------

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

  // Prior pass: tool-use id → tool name, so results attribute to tools.
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

// ---------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------

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
  // The runtime model is resolved before any counting; the context window is
  // looked up for it with the SDK betas (bootstrap state), not the merged
  // model+SDK beta set.
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

  // System prompt.
  const systemPromptResult = await countSystemPrompt(
    runtimeModel,
    tools,
    toolUseContext,
    mainThreadAgentDefinition,
  )

  // Memory files.
  const memoryFiles = await countMemoryFiles()

  // Built-in tools, split by the deferral predicate; enablement resolved for
  // the model and tool set.
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

  // The built-in lane keeps its empty-set early return, folded to these
  // call sites now that the generic counter no longer guards.
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
    // The used-in-history scan runs over the ORIGINAL (pre-microcompaction)
    // message list.
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

  // MCP tools. The used-in-history scan inside runs over the ORIGINAL
  // (pre-microcompaction) message list.
  const mcpResult = await countMcpToolTokens(
    mcpTools,
    getToolPermissionContext,
    agentInfo,
    runtimeModel,
    messages,
  )

  // Custom agents: everything whose source is not built-in.
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

  // Slash commands: the info is fetched BEFORE the tool lookup, so it is
  // requested even when the tool turns out to be absent, and a fetch
  // failure propagates. The schema is projected WITHOUT a model on this
  // lane.
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

  // Messages: breakdown from local estimates; the TOTAL from one API count
  // over the shared API normalizer's view of the microcompacted list — its
  // folding (attachments included) is part of the counted set — reduced to
  // role plus content only (the counting API rejects extra fields).
  const messageBreakdown = computeMessageBreakdown(analysisMessages)
  const normalizedForCount: CountableMessage[] = normalizeMessagesForAPI(analysisMessages).map(
    message => ({ role: message.message.role, content: message.message.content }),
  )
  const messageTokens =
    normalizedForCount.length > 0 ? ((await countMessagesTokens(normalizedForCount, [])) ?? 0) : 0

  // Skills: after the others and in its own error isolation — any failure
  // yields zero skills rather than failing the whole analysis.
  let skillsBlock: ContextData['skills']
  try {
    if (skillTool) {
      // The same call feeds the display block; the schema count is already
      // attributed to system tools, so the category total is the summed
      // per-skill frontmatter estimate instead (skill bodies only load on
      // invocation).
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
      // The listing-budget degradation (FN-013 MCP-05): the same detailed
      // formatter the announcement rides, over the same commands — so the
      // operator surface states exactly what the model-facing listing lost
      // (name-only entries, withheld names). null ⇒ nothing degraded.
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

  // Categories, in order; content categories push only when > 0.
  const categories: ContextCategory[] = []
  const pushContent = (name: string, tokens: number, color: string, isDeferred?: boolean): void => {
    if (tokens > 0) {
      const category: ContextCategory = { name, tokens, color }
      if (isDeferred) category.isDeferred = true
      categories.push(category)
    }
  }
  pushContent('System prompt', systemPromptResult.tokens, 'promptBorder')
  // The skills frontmatter total lives in the Skills category alone: it is
  // subtracted from the built-in tool total here (the push-only-when-
  // positive rule floors the result), so the two categories never both
  // contain it.
  pushContent('System tools', builtinToolTokens - (skillsBlock?.tokens ?? 0), 'inactive')
  pushContent('MCP tools', mcpResult.mcpToolTokens, 'cyan_FOR_SUBAGENTS_ONLY')
  pushContent('MCP tools (deferred)', mcpResult.deferredToolTokens, 'inactive', true)
  pushContent('System tools (deferred)', deferredBuiltinTokens, 'inactive', true)
  pushContent('Custom agents', agentTokens, 'permission')
  pushContent('Memory files', memoryFiles.tokens, 'brand')
  pushContent('Skills', skillsBlock?.tokens ?? 0, 'warning')
  pushContent('Messages', messageTokens, 'purple_FOR_SUBAGENTS_ONLY')

  // Actual usage: the non-deferred CONTENT categories, taken before the
  // reserve and free-space categories are appended.
  const actualUsage = categories
    .filter(category => !category.isDeferred)
    .reduce((total, category) => total + category.tokens, 0)

  // The headline is the compaction trigger's OWN count (contextFill: the last
  // wire usage in full — input, both cache families, output — plus what
  // landed after it), so /context, the rail and the trigger agree to the
  // token; the four-field envelope rides beside it for the detail rows.
  // Before any response exists the counted categories are the better
  // estimate (they include the system prompt and tools the rough
  // estimator cannot see).
  const apiUsage = getCurrentUsage(originalMessages ?? messages)
  const fill = contextFill(originalMessages ?? messages)
  const totalTokens = fill.source === 'usage' ? fill.tokens : actualUsage

  // ONE numerator for the whole screen (FN-018 rank 14): the breakdown,
  // the grid and Free space used to be computed from the measured
  // categories alone while the headline read the recorded usage — off the
  // Anthropic route every API-counted category coalesces to 0, so a
  // 200,000-token window holding 120,000 real tokens printed the headline
  // "120,000/200,000 (60%)" beside "Free space 197,000" and a grid painted
  // almost entirely free. Whatever the headline counts beyond the measured
  // categories is carried as its own row, so the rows, the grid and Free
  // space add up to the number at the top.
  const unmeasured = Math.max(0, totalTokens - actualUsage)
  pushContent('Unmeasured (recorded usage)', unmeasured, 'inactive')
  const usedForLayout = Math.max(actualUsage, totalTokens)

  // Exactly one reserve category — pushed whenever its branch is taken,
  // regardless of the computed value. The asymmetry is deliberate: the
  // context window is the RUNTIME model's, the threshold the REQUESTED
  // model's; when they differ the reserve absorbs the difference.
  const autoCompactOn = isAutoCompactEnabled()
  let reserveTokens: number
  let reserveName: string
  let autoCompactThreshold: number | undefined
  if (autoCompactOn) {
    // The shown threshold is the compact policy's OWN accessor over the
    // REQUESTED model — the same derivation the fire decision reads (one
    // owner; a second spelling of window−buffer here could drift from it).
    autoCompactThreshold = getAutoCompactThreshold(model)
    reserveTokens = contextWindow - autoCompactThreshold
    reserveName = 'Autocompact buffer'
  } else {
    reserveTokens = MANUAL_COMPACT_BUFFER_TOKENS
    reserveName = 'Compact buffer'
  }
  categories.push({ name: reserveName, tokens: reserveTokens, color: 'inactive' })

  const freeSpace = Math.max(0, contextWindow - usedForLayout - reserveTokens)
  // Free space is ALWAYS pushed, even at zero, so the list ends with it.
  categories.push({ name: FREE_SPACE_NAME, tokens: freeSpace, color: 'promptBorder' })

  const gridRows = buildGrid(categories, contextWindow, reserveName, terminalWidth)

  // The counting chain's own signature: a working counter always measures a
  // non-zero system prompt (never empty) — all-zero across prompt AND tools
  // AND messages means both counters answered nothing this analysis.
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
    // The per-section detail the counter builds (the field the type has
    // always declared and the analysis never filled — the /context row's
    // composition, one entry per prompt part, is what the pin reads).
    systemPromptSections: systemPromptResult.sections,
    mcpTools: mcpResult.mcpToolDetails,
    // The three per-item detail arrays exist in the type but are always
    // undefined in this build; the section detail is computed above and
    // deliberately not surfaced.
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
