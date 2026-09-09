import type * as React from 'react'

import { logError } from './utils/log.js'
import type { ZodType, output as ZodOutput } from 'zod/v4'

import type { OwnerKey } from './services/run/ownerKey.js'
import type { AgentId } from './types/ids.js'
import type { Command } from './types/command.js'
import type { ToolCapability } from './utils/capability/contract.js'
import type { DenialTrackingState } from './utils/permissions/denialTracking.js'
import type { ContentReplacementState } from './utils/toolResultStorage.js'
import type { AppState } from './state/AppState.js'
import type { MCPServerConnection } from './services/mcp/types.js'
import type { AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import type { FileHistoryState } from './utils/fileHistory.js'
import type { FileStateCache } from './utils/fileStateCache.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  SystemMessage,
} from './types/message.js'
import type { HookProgress, PromptRequest, PromptResponse } from './types/hooks.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import type { QuerySource } from './constants/querySource.js'
import type {
  InternalPermissionMode,
  PermissionDecision,
  PermissionResult,
  PermissionRuleSource,
  ToolPermissionRulesBySource,
} from './types/permissions.js'
import type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  ToolProgressData,
  WebSearchProgress,
} from './types/tools.js'
import type { ToolResultBlockParam } from './types/wire.js'
import type { SystemPrompt } from './utils/systemPromptType.js'


export type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  ToolProgressData,
  WebSearchProgress,
}
export type { ToolPermissionRulesBySource }

export type AnyObject = Record<string, unknown>

export type ToolInputJSONSchema = Record<string, any>

export type ValidationResult =
  | { result: true; message?: string; meta?: AnyObject }
  | { result: false; message: string; errorCode?: number; meta?: AnyObject }

export type QueryChainTracking = {
  chainId: string
  depth: number
}

export type SetToolJSXFn = (
  jsx: {
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
    shouldContinueAnimation?: true
    showSpinner?: boolean
    isLocalJSXCommand?: boolean
    clearLocalJSX?: boolean
    clearUnlessLocalJSX?: boolean
    deferIfLocalJSX?: boolean
    isImmediate?: boolean
  } | null,
) => void

type ReadonlyRulesBySource = {
  readonly [K in PermissionRuleSource]?: readonly string[]
}

export type ToolPermissionContext = {
  readonly mode: InternalPermissionMode
  readonly additionalWorkingDirectories: ReadonlyMap<string, unknown>
  readonly alwaysAllowRules: ReadonlyRulesBySource
  readonly alwaysDenyRules: ReadonlyRulesBySource
  readonly alwaysAskRules: ReadonlyRulesBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly isAutoModeAvailable?: boolean
  readonly strippedDangerousRules?: readonly string[]
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  readonly preStrategyMode?: InternalPermissionMode
}

export function getEmptyToolPermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }
}

export type CompactProgressEvent =
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

export type ToolRenderTheme =
  | 'light'
  | 'dark'
  | 'light-daltonized'
  | 'dark-daltonized'
  | 'light-ansi'
  | 'dark-ansi'

export type ToolRenderOptions = {
  theme: ToolRenderTheme
  tools?: Tools
  verbose: boolean
  [key: string]: any
}

export type ToolResultRenderOptions = ToolRenderOptions & {
  progressMessagesForMessage?: ProgressMessage[]
  style?: 'condensed' | 'default'
  isTranscriptMode?: boolean
  briefOnly?: boolean
  input?: unknown
  width?: number | string
}

export type AgentDefinitionsState = {
  activeAgents: AgentDefinition[]
  allowedAgentTypes?: string[]
  [key: string]: any
}

export type PermissionChannel = 'stdio' | 'prompt-tool'

export type ToolUseContext = {
  options: {
    commands: Command[]
    debug?: boolean
    verbose: boolean
    mainLoopModel: string
    maxThinkingTokens?: number
    thinkingConfig?: any
    tools: Tools
    refreshTools?: () => Tools
    mcpClients: MCPServerConnection[]
    mcpResources?: Record<string, any[]>
    isNonInteractiveSession: boolean
    permissionChannel?: PermissionChannel
    agentDefinitions: AgentDefinitionsState
    budget?: any
    customSystemPrompt?: string
    appendSystemPrompt?: string
    querySource?: QuerySource
    [key: string]: any
  }
  abortController: AbortController
  readFileState: FileStateCache
  getAppState: () => AppState
  setAppState: SetToolAppState
  setAppStateForTasks?: SetToolAppState
  messages: Message[]
  setProgressMessage?: (message: string | null) => void
  setResponseLength: (updater: (prev: number) => number) => void
  setStreamMode?: (mode: any) => void
  setInProgressToolUseIDs?: (updater: (prev: Set<string>) => Set<string>) => void
  updateFileHistoryState: (updater: (prev: FileHistoryState) => FileHistoryState) => void
  updateAttributionState: (updater: (prev: any) => any) => void
  addNotification?: (...args: any[]) => void
  sendOSNotification?: (notification: {
    message: string
    notificationType: string
  }) => Promise<string>
  appendSystemMessage?: (
    message: Exclude<SystemMessage, { subtype: 'local_command' }>,
  ) => void
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  handleElicitation?: (
    serverName: string,
    params: any,
    elicitSignal?: AbortSignal,
  ) => Promise<any>
  agentId?: AgentId
  agentType?: string
  seatHolder?: string
  onSeatWait?: (words: string | null) => void
  owner?: OwnerKey
  rosterOwner?: OwnerKey
  toolDecisions?: Map<string, PermissionDecision>
  fileReadingLimits?: any
  queryTracking?: QueryChainTracking
  nestedMemoryAttachmentTriggers?: Set<string>
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  discoveredSkillNames?: Set<string>
  preserveToolResults?: boolean
  alwaysCallCanUseTool?: boolean
  requireCanUseTool?: boolean
  localDenialTracking?: DenialTrackingState
  contentReplacementState?: ContentReplacementState
  renderedSystemPrompt?: SystemPrompt
  globLimits?: { maxResults?: number }
  setToolJSX?: SetToolJSXFn
  setIsInterruptibleToolRunning?: (running: boolean) => void
  onCompactProgress?: (event: CompactProgressEvent) => void
  setSDKStatus?: (status: any) => void
  openMessageSelector?: () => void
  setConversationId?: (id: any) => void
  toolUseId?: string
  userModifiedInput?: boolean
  standingRule?: string
}

type SetToolAppState = (updater: (prevState: AppState) => AppState) => void

interface ToolMembers<TInput, TOutput, TProgress extends ToolProgressData> {
  name: string
  aliases?: string[]
  inputJSONSchema?: ToolInputJSONSchema
  outputSchema?: ZodType
  strict?: boolean
  maxResultSizeChars: number
  shouldDefer?: boolean
  alwaysLoad?: boolean
  searchHint?: string
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
  isOpenWorld?(input?: TInput): boolean
  requiresUserInteraction?(input?: TInput): boolean
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
  isConcurrencySafe?(input: any): boolean
  isReadOnly?(input: any): boolean
  isDestructive?(input: any): boolean
  checkPermissions?(input: any, context: ToolUseContext): Promise<PermissionResult>
  toAutoClassifierInput?(input: any): string | undefined
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
  toAutoClassifierInput(input?: any): string | undefined
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
  inputSchema: ZodType<TInput, any>
  isEnabled(): boolean
  isConcurrencySafe(input: any): boolean
  isReadOnly(input: any): boolean
  checkPermissions(input: any, context: ToolUseContext): Promise<PermissionResult>
  toAutoClassifierInput(input: any): string | undefined
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

export type ToolInputOf<T> = T extends ZodType ? ZodOutput<T> : T

export const TOOL_DEFAULT_MARKER = '__mercuryToolDefault'

export function isToolDefaultFn(fn: unknown): boolean {
  return (
    typeof fn === 'function' &&
    (fn as unknown as Record<string, unknown>)[TOOL_DEFAULT_MARKER] === true
  )
}

function markDefault<F extends (...args: never[]) => unknown>(fn: F): F {
  Object.defineProperty(fn, TOOL_DEFAULT_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
  })
  return fn
}

export function buildTool<D extends ToolDef<any, any, any>>(def: D): D & ToolDefaults {
  const tool = {
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    checkPermissions: async (input: any) =>
      ({ behavior: 'allow', updatedInput: input }) as PermissionResult,
    toAutoClassifierInput: markDefault(() => ''),
    userFacingName: () => def.name,
    renderToolUseMessage: () => null,
    renderToolUseProgressMessage: () => null,
    renderToolUseQueuedMessage: () => null,
    renderToolUseRejectedMessage: () => null,
    renderToolUseErrorMessage: () => null,
    renderToolResultMessage: () => null,
    ...def,
  }
  return tool as D & ToolDefaults
}

export function filterToolProgressMessages(
  progressMessages: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
  return progressMessages.filter(
    message =>
      (message.data as { type?: string } | undefined)?.type !== 'hook_progress',
  ) as ProgressMessage<ToolProgressData>[]
}

export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  if (tool.name === name) return true
  return tool.aliases?.includes(name) ?? false
}

export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(tool => toolMatchesName(tool, name))
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
  if (!tool || !classifier || isToolDefaultFn(classifier)) return undefined
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
