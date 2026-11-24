import type { StartTurn } from '../../engine/turn-entry/startTurn.js'
import type * as React from 'react'

import { logError } from '../../platform/logs/errorLog.js'
import type { ZodType, output as ZodOutput } from 'zod/v4'

import type { OwnerKey } from '../../engine/run-owner/ownerKey.js'
import type { AgentId } from '../../sessions/transcripts/ids.js'
import type { Command } from '../../commands/catalogue/command.js'
import type { ToolCapability } from '../../permissions/capability/contract.js'
import type { ContentReplacementState } from '../../engine/tool-dispatch/toolResultStorage.js'
import type { AppState } from '../../screen/app-state/AppState.js'
import type { QueuedCommand } from '../../screen/composer/input-core/textInput.js'
import type { MCPServerConnection } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import type { FileHistoryState } from '../../sessions/transcripts/fileHistory.js'
import type { FileStateCache } from '../../platform/files/fileStateCache.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  SystemMessage,
} from '../../engine/message-shapes/message.js'
import type { HookProgress } from '../../integrations/event-hooks/hookProgress.js'
import type { QuerySource } from '../../engine/requests/querySource.js'
import type {
  InternalPermissionMode,
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecision,
  PermissionResult,
  PermissionRuleSource,
  ToolPermissionRulesBySource,
} from '../../permissions/rules/permissions.js'
import type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  SkillToolProgress,
  ToolProgressData,
  WebSearchProgress,
} from './toolProgress.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import type { SystemPrompt } from '../../engine/system-prompt/systemPromptType.js'


export type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  SkillToolProgress,
  ToolProgressData,
  WebSearchProgress,
}
export type { ToolPermissionRulesBySource }

export type AnyObject = { [key: string]: unknown }

export type ToolInputJSONSchema = { [x: string]: any }

export type ValidationResult =
  | { result: true; message?: string; meta?: AnyObject }
  | { result: false; message: string; errorCode?: number; meta?: AnyObject }

export type ToolCallChain = {
  key: string
  hop: number
}

type ToolCallChainCarrier = { callChain?: ToolCallChain }

export function readToolCallChain(context: ToolCallChainCarrier | undefined): ToolCallChain | undefined {
  return context?.callChain
}

export function advanceToolCallChain(
  context: ToolCallChainCarrier | undefined,
  mintKey: () => string,
  mode: 'continue' | 'fork' = 'continue',
): ToolCallChain {
  const parent = readToolCallChain(context)
  return {
    key: mode === 'fork' || !parent ? mintKey() : parent.key,
    hop: (parent?.hop ?? -1) + 1,
  }
}

export type ToolTerminalFrame = {
  jsx: React.ReactNode | null
  shouldHidePromptInput: boolean
  shouldContinueAnimation?: true
  showSpinner?: boolean
  isLocalJSXCommand?: boolean
  clearLocalJSX?: boolean
  clearUnlessLocalJSX?: boolean
  deferIfLocalJSX?: boolean
  isImmediate?: boolean
}

export type SetToolJSXFn = (frame: ToolTerminalFrame | null) => void

type ReadonlyRulesBySource = {
  readonly [K in PermissionRuleSource]?: readonly string[]
}

type ReadonlyRuleReasonsBySource = {
  readonly [K in PermissionRuleSource]?: { readonly [spelling: string]: string }
}

export type ToolPermissionContext = {
  readonly mode: InternalPermissionMode
  readonly baseTools?: readonly string[]
  readonly alwaysAllowRules: ReadonlyRulesBySource
  readonly alwaysDenyRules: ReadonlyRulesBySource
  readonly alwaysAskRules: ReadonlyRulesBySource
  readonly ruleReasons?: ReadonlyRuleReasonsBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly isFlowAvailable?: boolean
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  readonly strippedDangerousRules?: ReadonlyRulesBySource
}

export function getEmptyToolPermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }
}

export type FoldProgressEvent =
  | { type: 'hooks_start'; hookType: 'pre_compact' | 'post_compact' | 'session_start' }
  | { type: 'compact_start' }
  | { type: 'compact_end' }
  | { type: 'stage'; stage: 'session-memory' | 'micro-compaction' | 'summarising' | 'restoring' }
  | { type: 'summary_progress'; chars: number }
  | { type: 'retry'; attempt: number }

export type Progress = ToolProgressData | HookProgress

export type ToolProgress<P extends ToolProgressData = ToolProgressData> = {
  toolUseID: string
  data: P
}

export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

export type ToolEffectOutcome = 'succeeded' | 'failed' | 'no-change' | 'indeterminate'

export type ToolEffect = {
  outcome: ToolEffectOutcome
  operation: string
  changedPaths: string[]
  evidence: string
  startedAt: number
  completedAt: number
  details?: AnyObject
}

export interface ChangeIntentProjection {
  targetPaths: string[]
  expectedAnchor?: string
  targetVersions?: Array<{ path: string; version: string }>
}

export type ToolResult<TOutput = unknown> = {
  data: TOutput
  effect?: ToolEffect
  changeIntent?: ChangeIntentProjection
  newMessages?: Message[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}

export type McpToolInfo = {
  serverName: string
  toolName: string
  effectiveMaxPermission?: 'ask' | 'blocked' | string
  [key: string]: any
}

export type ToolInterruptBehavior = 'cancel' | 'block'

export type SearchOrReadClassification = {
  isSearch: boolean
  isRead: boolean
  isList?: boolean
}

type MaybePromise<T> = T | Promise<T>

export type ToolRenderTheme = 'dark' | 'true-black'

export type ToolRenderOptions = {
  theme: ToolRenderTheme
  tools?: Tools
  verbose: boolean
  [key: string]: any
}

export type AgentDefinitionsState = {
  activeAgents: AgentDefinition[]
  allowedAgentTypes?: string[]
  [key: string]: any
}

export type ToolSessionOptions = {
  commands: Command[]
  debug?: boolean
  verbose: boolean
  engineModel: string
  tools: Tools
  mcpClients: MCPServerConnection[]
  isNonInteractiveSession: boolean
  agentDefinitions: AgentDefinitionsState
  maxThinkingTokens?: number
  thinkingConfig?: any
  refreshTools?: () => Tools
  mcpResources?: Record<string, any[]>
  hostHoldsAsks?: boolean
  runDeadline?: { at: number; limitMs: number }
  budget?: any
  customSystemPrompt?: string
  appendSystemPrompt?: string
  querySource?: QuerySource
  [key: string]: any
}

export type ToolTerminalOptions = {
  setProgressMessage?: (message: string | null) => void
  setStreamMode?: (mode: any) => void
  setInProgressToolUseIDs?: (f: (prev: Set<string>) => Set<string>) => void
  setResponseLength: (f: (prev: number) => number) => void
  addNotification?: (...args: any[]) => void
  appendSystemMessage?: (
    msg: Exclude<SystemMessage, { subtype: 'local_command' }>,
  ) => void
  handleElicitation?: (
    serverName: string,
    params: any,
    signal?: AbortSignal,
  ) => Promise<any>
  onSeatWait?: (wait: string | null) => void
  setToolJSX?: SetToolJSXFn
  setIsInterruptibleToolRunning?: (v: boolean) => void
  onCompactProgress?: (event: FoldProgressEvent) => void
  setSDKStatus?: (status: any) => void
  takeModeNotice?: () => QueuedCommand | null
  openMessageSelector?: () => void
  setConversationId?: (id: any) => void
}

export type ToolUseContext = ToolTerminalOptions & ToolCallChainCarrier & {
  options: ToolSessionOptions
  startTurn: StartTurn
  abortController: AbortController
  readFileState: FileStateCache
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  setAppStateForTasks?: (f: (prev: AppState) => AppState) => void
  messages: Message[]
  updateFileHistoryState: (updater: (prev: FileHistoryState) => FileHistoryState) => void
  updateAttributionState: (updater: (prev: any) => any) => void
  agentId?: AgentId
  agentType?: string
  agentKind?: 'crewmate'
  seatHolder?: string
  roundHandle?: string
  owner?: OwnerKey
  rosterOwner?: OwnerKey
  toolDecisions?: Map<string, PermissionDecision>
  fileReadingLimits?: any
  nestedMemoryAttachmentTriggers?: Set<string>
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  discoveredSkillNames?: Set<string>
  preserveToolResults?: boolean
  alwaysCallCanUseTool?: boolean
  requireCanUseTool?: boolean
  userModifiedInput?: boolean
  contentReplacementState?: ContentReplacementState
  renderedSystemPrompt?: SystemPrompt
  globLimits?: { maxResults?: number }
  toolUseId?: string
  shellInputId?: string
  standingRule?: string
}

interface ToolMembers<TInput, TOutput, TProgress extends ToolProgressData> {
  name: string
  aliases?: string[]
  inputJSONSchema?: ToolInputJSONSchema
  outputSchema?: ZodType
  strict?: boolean
  keepEmptyInputs?: readonly string[]
  straightQuoteInputs?: readonly string[]
  maxResultSizeChars: number
  shouldDefer?: boolean
  alwaysLoad?: boolean
  loadInFullOnCloud?: boolean
  searchHint?: string
  searchKeywords?: readonly string[]
  userFacingNameBackgroundColor?(input?: any): string | undefined
  description(
    input?: any,
    options?: {
      isNonInteractiveSession?: boolean
      toolPermissionContext?: ToolPermissionContext
      tools?: Tools
    },
  ): Promise<string>
  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
    model?: string
  }): Promise<string>
  wireDescription?(fullPrompt: string): string
  manualText?(fullPrompt: string): string
  isOpenWorld?(input?: TInput): boolean
  requiresUserInteraction?(input?: TInput): boolean
  settleUnansweredAsk?(input: TInput, ask: PermissionAskDecision): PermissionAllowDecision | null
  isTransparentWrapper?(): boolean
  interruptBehavior?(): ToolInterruptBehavior
  isSearchOrReadCommand?: (input: unknown) => SearchOrReadClassification
  validateInput?(input: any, context: ToolUseContext): MaybePromise<ValidationResult>
  preparePermissionMatcher?(
    input: any,
    context?: ToolUseContext,
  ): MaybePromise<((rulePattern: string) => boolean) | undefined>
  call(
    input: TInput,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentAssistantMessage: AssistantMessage,
    onProgress?: ToolCallProgress<TProgress>,
  ): Promise<ToolResult<TOutput>>
  mapToolResultToToolResultBlockParam(
    output: TOutput,
    toolUseID: string,
  ): ToolResultBlockParam
  backfillObservableInput?(input: TInput): void
  extractSearchText?(output: TOutput): string
  inputsEquivalent?(a: any, b: any): boolean
  getPath?(input: any): string | undefined
  shellCommandOf?(input: unknown): string | undefined
  capability?: ToolCapability
  getToolUseSummary?(input?: any): string | null
  getActivityDescription?(input?: any): string | null
  isResultTruncated?(output: TOutput): boolean
  renderToolUseMessage?(input?: any, options?: any): React.ReactNode | string | null
  renderToolUseProgressMessage?(progress?: any, options?: any): React.ReactNode
  renderToolUseQueuedMessage?(input?: any, options?: any): React.ReactNode
  renderToolUseRejectedMessage?(input?: any, options?: any): React.ReactNode
  renderToolUseErrorMessage?(error?: any, options?: any): React.ReactNode
  renderToolResultMessage?(output?: any, progressMessages?: any, options?: any): React.ReactNode
  renderGroupedToolUse?(...args: any[]): React.ReactNode
  renderToolUseTag?(input?: any, options?: any): React.ReactNode | string | null
  renderCompactSummary?(...args: any[]): React.ReactNode
  isMcp?: boolean
  mcpInfo?: McpToolInfo
  isLsp?: boolean
  isEnabled?(): boolean
  prepare?(input: TInput): Promise<void>
  isConcurrencySafe?(input: any): boolean
  isReadOnly?(input: any): boolean
  isDestructive?(input: any): boolean
  checkPermissions?(input: any, context: ToolUseContext): Promise<PermissionResult>
  userFacingName?(input?: any): string
}

export interface ToolDef<
  TSchema extends ZodType = ZodType,
  TOutput = any,
  TProgress extends ToolProgressData = ToolProgressData,
> extends ToolMembers<ZodOutput<TSchema>, TOutput, TProgress> {
  inputSchema: TSchema
}

export type ToolDefaults = {
  isEnabled(): boolean
  isConcurrencySafe(input?: any): boolean
  isReadOnly(input?: any): boolean
  isDestructive(input?: any): boolean
  checkPermissions(input?: any, context?: ToolUseContext): Promise<PermissionResult>
  userFacingName(input?: any): string
  renderToolUseMessage(input?: any, options?: any): React.ReactNode | string | null
  renderToolUseProgressMessage(progress?: any, options?: any): React.ReactNode
  renderToolUseQueuedMessage(input?: any, options?: any): React.ReactNode
  renderToolUseRejectedMessage(input?: any, options?: any): React.ReactNode
  renderToolUseErrorMessage(error?: any, options?: any): React.ReactNode
  renderToolResultMessage(output?: any, progressMessages?: any, options?: any): React.ReactNode
}

export type Tool<
  TIn = any,
  TOutput = any,
  TProgress extends ToolProgressData = ToolProgressData,
  TInput = ToolInputOf<TIn>,
> = ToolMembers<TInput, TOutput, TProgress> & {
  inputSchema: ZodType<TInput>
  isEnabled(): boolean
  isConcurrencySafe(input: any): boolean
  isReadOnly(input: any): boolean
  checkPermissions(input: any, context: ToolUseContext): Promise<PermissionResult>
  userFacingName(input?: Partial<TInput>): string
  renderToolUseMessage(input?: any, options?: any): React.ReactNode | string | null
  renderToolUseRejectedMessage(input?: any, options?: any): React.ReactNode
  renderToolResultMessage(output?: any, progressMessages?: any, options?: any): React.ReactNode
  renderToolUseErrorMessage(error?: any, options?: any): React.ReactNode
  prompt(options?: {
    getToolPermissionContext?: () => Promise<ToolPermissionContext>
    tools?: Tools
    agents?: AgentDefinition[]
    allowedAgentTypes?: string[]
    model?: string
  }): Promise<string>
}

export type Tools = readonly Tool[]

export type CanUseToolFn<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = (
  tool: Tool,
  input: Input,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  forceDecision?: PermissionDecision,
) => Promise<PermissionDecision>

export type ToolInputOf<T> = T extends ZodType ? ZodOutput<T> : T

export function buildTool<D extends ToolDef<any, any, any>>(def: D): D & ToolDefaults {
  return {
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    checkPermissions: input => Promise.resolve({ behavior: 'allow', updatedInput: input }),
    userFacingName: () => def.name,
    renderToolUseMessage: () => null,
    renderToolUseProgressMessage: () => null,
    renderToolUseQueuedMessage: () => null,
    renderToolUseRejectedMessage: () => null,
    renderToolUseErrorMessage: () => null,
    renderToolResultMessage: () => null,
    ...def,
  }
}

export function filterToolProgressMessages(
  progressMessages: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
  return progressMessages.filter(
    (message): message is ProgressMessage<ToolProgressData> => message.data.type !== 'hook_progress',
  )
}

export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

function toolMatchesFoldedName(
  tool: { name: string; aliases?: string[] },
  folded: string,
): boolean {
  return tool.name.toLowerCase() === folded || (tool.aliases?.some(alias => alias.toLowerCase() === folded) ?? false)
}

function findToolByFoldedName(tools: Tools, name: string): Tool | undefined {
  const folded = name.toLowerCase()
  let hit: Tool | undefined
  for (const tool of tools) {
    if (!toolMatchesFoldedName(tool, folded)) continue
    if (hit !== undefined && hit !== tool) return undefined
    hit = tool
  }
  return hit
}

export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(tool => toolMatchesName(tool, name)) ?? findToolByFoldedName(tools, name)
}

export const TOOL_NAME_SUGGESTION_MAX_DISTANCE = 2

const TOOL_NAME_HEAD_MIN_LENGTH = 4

function toolNameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 0)
}

function toolNameForms(name: string): string[] {
  const tokens = toolNameTokens(name)
  if (tokens.length === 0) return []
  const full = tokens.join('')
  if (tokens.length === 1) return [full]
  const head = tokens.slice(0, -1).join('')
  return head.length >= TOOL_NAME_HEAD_MIN_LENGTH ? [full, head] : [full]
}

function editDistanceWithin(a: string, b: string, bound: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > bound) return bound + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
      current.push(value)
      if (value < rowMin) rowMin = value
    }
    if (rowMin > bound) return bound + 1
    previous = current
  }
  return previous[b.length]!
}

export function closestToolByName(tools: Tools, name: string): Tool | undefined {
  const forms = toolNameForms(name)
  if (forms.length === 0) return undefined
  let closest: Tool | undefined
  let closestDistance = TOOL_NAME_SUGGESTION_MAX_DISTANCE + 1
  for (const tool of tools) {
    const target = toolNameTokens(tool.name).join('')
    if (target.length === 0) continue
    for (const form of forms) {
      const distance = editDistanceWithin(form, target, TOOL_NAME_SUGGESTION_MAX_DISTANCE)
      if (distance < closestDistance) {
        closestDistance = distance
        closest = tool
      }
    }
  }
  return closest
}

const OFFERED_TOOL_NAMES_SHOWN = 64

export function offeredToolNamesClause(tools: ReadonlyArray<{ name: string }>): string {
  const names = tools.map(tool => tool.name).filter(name => name !== '')
  if (names.length === 0) return ''
  const shown = names.slice(0, OFFERED_TOOL_NAMES_SHOWN)
  const rest = names.length - shown.length
  return `: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`
}

export function safeUserFacingName(
  tool: { name: string; userFacingName?: (input?: any) => string },
  input: unknown,
  fallback?: string,
): string {
  try {
    return tool.userFacingName?.(input) ?? fallback ?? tool.name
  } catch {
    return fallback ?? tool.name
  }
}

export function stringInputField(input: unknown, field: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

const loggedClassifierThrows = new Set<string>()

export function safeSearchOrReadClassification(
  tool: Tool | undefined,
  input: unknown,
): SearchOrReadClassification | undefined {
  const classifier = tool?.isSearchOrReadCommand
  if (!tool || !classifier) return undefined
  try {
    return classifier(input)
  } catch (error) {
    if (!loggedClassifierThrows.has(tool.name)) {
      loggedClassifierThrows.add(tool.name)
      logError(error)
    }
    return undefined
  }
}
