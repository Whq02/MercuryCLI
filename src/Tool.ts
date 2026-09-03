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

/**
 * The Tool contract: the one type every tool implements, the execution
 * context handed to a running tool, the result envelope, and the
 * default-filling tool constructor.
 */

// Compatibility re-exports so tool implementations have one import site.
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

/** A JSON-Schema object carried for the wire when a tool bypasses zod. */
export type ToolInputJSONSchema = Record<string, any>

/**
 * Input validation verdict from a tool's own semantic check: success, or a
 * failure carrying a message and a numeric error code.
 */
export type ValidationResult =
  | { result: true; message?: string; meta?: AnyObject }
  | { result: false; message: string; errorCode?: number; meta?: AnyObject }

/** Query-chain tracking threaded through nested tool calls. */
export type QueryChainTracking = {
  chainId: string
  depth: number
}

/** The takeover surface a tool can paint into (null clears it). */
export type SetToolJSXFn = (
  jsx: {
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
    shouldContinueAnimation?: true
    showSpinner?: boolean
    isLocalJSXCommand?: boolean
    clearLocalJSX?: boolean
    /** Clear the slot UNLESS a local-JSX dialog now owns it (a foreground
     *  `!` command tearing down its own progress must not destroy a dialog
     *  opened over it). */
    clearUnlessLocalJSX?: boolean
    /** Yield to a local-JSX dialog already in the slot rather than
     *  overwriting it (a `!` command's periodic progress render). */
    deferIfLocalJSX?: boolean
    isImmediate?: boolean
  } | null,
) => void

/** The readonly rule-set view carried by the permission context. */
type ReadonlyRulesBySource = {
  readonly [K in PermissionRuleSource]?: readonly string[]
}

/**
 * The permission posture carried through a turn. Deeply immutable — every
 * transform produces a new object.
 */
export type ToolPermissionContext = {
  readonly mode: InternalPermissionMode
  readonly additionalWorkingDirectories: ReadonlyMap<string, unknown>
  readonly alwaysAllowRules: ReadonlyRulesBySource
  readonly alwaysDenyRules: ReadonlyRulesBySource
  readonly alwaysAskRules: ReadonlyRulesBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly isAutoModeAvailable?: boolean
  /** Dangerous blanket-allow rules stripped by the auto-mode posture. */
  readonly strippedDangerousRules?: readonly string[]
  /** Background agents that cannot show UI auto-deny prompts. */
  readonly shouldAvoidPermissionPrompts?: boolean
  /** Coordinator workers await automated checks before showing the dialog. */
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  /** The mode to restore when strategy mode exits. */
  readonly prePlanMode?: InternalPermissionMode
}

/** A fresh permissive-shaped but empty permission context. */
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

/** Events surfaced through the compaction-progress callback (contract data). */
export type CompactProgressEvent =
  | { type: 'hooks_start'; hookType: 'pre_compact' | 'post_compact' | 'session_start' }
  | { type: 'compact_start' }
  | { type: 'compact_end' }

/**
 * The union of progress payloads a ProgressMessage may carry: every
 * tool-progress shape plus the hook channel's. Every tool member's `type`
 * discriminant is distinct from 'hook_progress' — that is what
 * filterToolProgressMessages separates on.
 */
export type Progress = ToolProgressData | HookProgress

/** A tool-progress envelope streamed by a running tool. */
export type ToolProgress<P extends ToolProgressData = ToolProgressData> = {
  toolUseID: string
  data: P
}

/** The progress callback a tool's call receives. */
export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

/** Typed-effect outcomes (contract data). */
export type ToolEffectOutcome = 'succeeded' | 'failed' | 'no-change' | 'indeterminate'

/**
 * A typed effect a tool attaches to its result when it knows what
 * happened. Bounded and serialisable — never a content dump.
 */
export type ToolEffect = {
  outcome: ToolEffectOutcome
  /** Operation identity, e.g. 'edit.apply'. */
  operation: string
  /** The exact absolute paths actually written (empty for pure reads). */
  changedPaths: string[]
  /** One-sentence, bounded evidence for the outcome. */
  evidence: string
  startedAt: number
  completedAt: number
  /** Small structured details (never large content). */
  details?: AnyObject
}

/**
 * What a call *set out* to touch, declared by the tool. Receipts prefer
 * this over input-shape guessing; bounded to paths and versions, never
 * content.
 */
export interface ChangeIntentProjection {
  targetPaths: string[]
  expectedAnchor?: string
  targetVersions?: Array<{ path: string; version: string }>
}

/** The result envelope a tool's call resolves with. */
export type ToolResult<TOutput = unknown> = {
  data: TOutput
  effect?: ToolEffect
  changeIntent?: ChangeIntentProjection
  /** Messages to append to the conversation after the tool result. */
  newMessages?: Message[]
  /**
   * A context modifier honoured only for tools that are not
   * concurrency-safe (serial batches apply it before the next call).
   */
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  /** MCP protocol pass-through metadata (never sent to the model). */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}

/** MCP provenance carried by MCP-backed tools. */
export type McpToolInfo = {
  serverName: string
  toolName: string
  /** The per-tool permission ceiling from the server config. */
  effectiveMaxPermission?: 'ask' | 'blocked' | string
  [key: string]: any
}

/** How a running tool reacts to a new user message (contract data). */
export type ToolInterruptBehavior = 'cancel' | 'block'

/** The search/read classification for condensed transcript rows. */
export type SearchOrReadClassification = {
  isSearch: boolean
  isRead: boolean
  isList?: boolean
}

type MaybePromise<T> = T | Promise<T>

/** The theme vocabulary render hooks receive (contract data). */
export type ToolRenderTheme =
  | 'light'
  | 'dark'
  | 'light-daltonized'
  | 'dark-daltonized'
  | 'light-ansi'
  | 'dark-ansi'

/** The option bag handed to render hooks. */
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
  /** The original input of the call this result answers. */
  input?: unknown
  width?: number | string
}

/** The active agent-definitions state carried on the session options. */
export type AgentDefinitionsState = {
  activeAgents: AgentDefinition[]
  allowedAgentTypes?: string[]
  [key: string]: any
}

/**
 * The execution context a running tool may reach. Hosts wire different
 * subsets — every optional UI/SDK hook must be treated as possibly absent.
 */
export type ToolUseContext = {
  options: {
    commands: Command[]
    debug?: boolean
    verbose: boolean
    mainLoopModel: string
    maxThinkingTokens?: number
    thinkingConfig?: any
    tools: Tools
    /** Live refresher for the tool list, when the host supports it. */
    refreshTools?: () => Tools
    mcpClients: MCPServerConnection[]
    mcpResources?: Record<string, any[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsState
    budget?: any
    customSystemPrompt?: string
    appendSystemPrompt?: string
    querySource?: QuerySource
    [key: string]: any
  }
  abortController: AbortController
  /** Bounded LRU of file reads — entries may be discarded under load. */
  readFileState: FileStateCache
  getAppState: () => AppState
  setAppState: SetToolAppState
  /**
   * Session-scoped app-state writer for infrastructure that must outlive
   * one turn (background tasks, session hooks) — the normal writer is a
   * no-op for async agents.
   */
  setAppStateForTasks?: SetToolAppState
  messages: Message[]
  setProgressMessage?: (message: string | null) => void
  /** Required: mercury-original consumers invoke it unguarded (the
   *  foreground agent loop counts child tokens through it). */
  setResponseLength: (updater: (prev: number) => number) => void
  setStreamMode?: (mode: any) => void
  setInProgressToolUseIDs?: (updater: (prev: Set<string>) => Set<string>) => void
  updateFileHistoryState: (updater: (prev: FileHistoryState) => FileHistoryState) => void
  updateAttributionState: (updater: (prev: any) => any) => void
  addNotification?: (...args: any[]) => void
  /**
   * Send an OS-level notification; resolves to the method actually
   * dispatched ('iterm2' | 'kitty' | 'ghostty' | 'terminal_bell' |
   * 'iterm2_with_bell') or a non-delivery sentinel ('no_method_available' |
   * 'none' | 'disabled' | 'error').
   */
  sendOSNotification?: (notification: {
    message: string
    notificationType: string
  }) => Promise<string>
  /** Append a UI-only system message (local-command messages excluded). */
  appendSystemMessage?: (
    message: Exclude<SystemMessage, { subtype: 'local_command' }>,
  ) => void
  /** Interactive prompt-request factory (present in interactive hosts). */
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  /** Elicitation handler — present only in print/SDK mode. */
  handleElicitation?: (
    serverName: string,
    params: any,
    elicitSignal?: AbortSignal,
  ) => Promise<any>
  agentId?: AgentId
  agentType?: string
  /** Owner key for attribution, when threaded explicitly. */
  owner?: OwnerKey
  /** The conversation whose frozen tool roster this context's requests
   *  ride when it is not its own: a cache-sharing fork carries its parent's
   *  context messages, so its requests must carry the parent's tools array
   *  byte-for-byte (the prefix every parent thinking block is bound to). */
  rosterOwner?: OwnerKey
  /** Per-call decisions keyed by tool-use id. */
  toolDecisions?: Map<string, PermissionDecision>
  fileReadingLimits?: any
  queryTracking?: QueryChainTracking
  /** Dedup set: nested memory attachment triggers already fired. */
  nestedMemoryAttachmentTriggers?: Set<string>
  /**
   * Permanent record of nested memory files already injected this
   * session. Deliberately not folded into readFileState: that cache
   * evicts under load, and an evicted entry would re-inject the file.
   */
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  discoveredSkillNames?: Set<string>
  /** Keep non-model-visible tool results on emitted messages (teammates). */
  preserveToolResults?: boolean
  /** Force every decision through the permission callback. */
  alwaysCallCanUseTool?: boolean
  /** Written by the forked-agent context builder; no in-tree reader. */
  requireCanUseTool?: boolean
  /**
   * Local denial tracking for async subagents whose app-state writer does
   * nothing. Mutated in place so the counter accumulates across calls.
   */
  localDenialTracking?: DenialTrackingState
  contentReplacementState?: ContentReplacementState
  /** The parent's frozen rendered system prompt. */
  renderedSystemPrompt?: SystemPrompt
  /** Result-count bounds for the glob tool, when the host constrains it. */
  globLimits?: { maxResults?: number }
  // ── optional UI/SDK hooks ──────────────────────────────────────────────
  setToolJSX?: SetToolJSXFn
  setIsInterruptibleToolRunning?: (running: boolean) => void
  onCompactProgress?: (event: CompactProgressEvent) => void
  setSDKStatus?: (status: any) => void
  openMessageSelector?: () => void
  setConversationId?: (id: any) => void
  /** The tool-use id of the call currently executing. */
  toolUseId?: string
  /** Whether the user modified the input at the permission dialog. */
  userModifiedInput?: boolean
  criticalSystemReminder_EXPERIMENTAL?: string
}

type SetToolAppState = (updater: (prevState: AppState) => AppState) => void

/**
 * Every tool member, generic over the parsed input type. The seven
 * defaultable members are optional here; buildTool fills them. Declared as
 * a plain interface (method syntax) so object-literal implementations get
 * contextual parameter typing and bivariant parameter checks.
 */
interface ToolMembers<TInput, TOutput, TProgress extends ToolProgressData> {
  name: string
  /** Older names that must keep resolving after a rename. */
  aliases?: string[]
  /** The wire schema shown to the model when it differs from the zod form. */
  inputJSONSchema?: ToolInputJSONSchema
  outputSchema?: ZodType
  /** Honoured only when the server-side strict-schema gate is on. */
  strict?: boolean
  /**
   * Bounds when a result is persisted to disk instead of sent inline. A
   * tool whose output must never be persisted declares Infinity.
   */
  maxResultSizeChars: number
  /** Defer this tool's schema until discovered via tool search. */
  shouldDefer?: boolean
  /** Never defer this tool (overrides shouldDefer). */
  alwaysLoad?: boolean
  /** 3–10 word capability phrase for deferred-tool keyword matching. */
  searchHint?: string
  /** Theme-key background colour for the user-facing name chip. */
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
    /** The model the rendered text will be sent to — capability-derived
     *  prompt content (media lines) must read THIS model's record, never
     *  ambient main-loop state (one session serves several lanes). */
    model?: string
  }): Promise<string>
  /** Open-world tools reach beyond the local machine (web, MCP). */
  isOpenWorld?(input?: TInput): boolean
  requiresUserInteraction?(input?: TInput): boolean
  /** Transparent wrappers relay another tool's work (REPL, skills). */
  isTransparentWrapper?(): boolean
  /** What happens on a new user message while running (contract data). */
  interruptBehavior?(): ToolInterruptBehavior
  /** Search/read classification for condensed transcript rows. Receives
   *  whatever the wire or the streaming projection carries — the
   *  block-start placeholder `{}`, a partial object, a settled call that
   *  fails the schema — so it narrows from `unknown` and answers the
   *  not-search/not-read shape for anything it cannot read. */
  isSearchOrReadCommand?: (input: unknown) => SearchOrReadClassification
  validateInput?(input: any, context: ToolUseContext): MaybePromise<ValidationResult>
  /** Per-pattern permission matcher factory. */
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
  /**
   * Idempotent observable-input backfill: mutates only the clone it is
   * given so observers see derived fields while the sent bytes stay
   * stable.
   */
  backfillObservableInput?(input: TInput): void
  /** Search text that actually renders in transcript mode. */
  extractSearchText?(output: TOutput): string
  /** Input-equivalence predicate (dedup/matching). */
  inputsEquivalent?(a: any, b: any): boolean
  /** Extract the path this call touches, when the tool knows. */
  getPath?(input: any): string | undefined
  /** The declared capability contract (required for production built-ins). */
  capability?: ToolCapability
  getToolUseSummary?(input?: any): string | null
  getActivityDescription?(input?: any): string | null
  isResultTruncated?(output: TOutput): boolean
  // ── transcript render hooks ────────────────────────────────────────────
  renderToolUseMessage?(input?: any, options?: any): React.ReactNode | string | null
  renderToolUseProgressMessage?(progress?: any, options?: any): React.ReactNode
  renderToolUseQueuedMessage?(input?: any, options?: any): React.ReactNode
  renderToolUseRejectedMessage?(input?: any, options?: any): React.ReactNode
  renderToolUseErrorMessage?(error?: any, options?: any): React.ReactNode
  renderToolResultMessage?(output?: any, progressMessages?: any, options?: any): React.ReactNode
  renderGroupedToolUse?(...args: any[]): React.ReactNode
  /** Optional tag drawn after the tool-use line. */
  renderToolUseTag?(input?: any, options?: any): React.ReactNode | string | null
  /** Compact one-line summary renderer. */
  renderCompactSummary?(...args: any[]): React.ReactNode
  /** MCP provenance; present only on MCP-backed tools. */
  isMcp?: boolean
  mcpInfo?: McpToolInfo
  /** LSP provenance marker. */
  isLsp?: boolean
  // ── the seven defaultable members (optional here; buildTool fills) ─────
  isEnabled?(): boolean
  isConcurrencySafe?(input: any): boolean
  isReadOnly?(input: any): boolean
  isDestructive?(input: any): boolean
  checkPermissions?(input: any, context: ToolUseContext): Promise<PermissionResult>
  /** Projection of the input for the auto-mode security classifier. */
  toAutoClassifierInput?(input: any): string | undefined
  userFacingName?(input?: any): string
}

/**
 * The buildTool input: schema-first (the parsed input type is derived from
 * the zod schema). Extra members are tolerated so a definition can carry
 * private fields.
 */
export interface ToolDef<
  TSchema extends ZodType = ZodType,
  TOutput = any,
  TProgress extends ToolProgressData = ToolProgressData,
> extends ToolMembers<ZodOutput<TSchema>, TOutput, TProgress> {
  inputSchema: TSchema
}


/** The members buildTool fills when a definition omits them: the seven
 *  fail-closed semantic defaults, plus null-rendering transcript hooks so
 *  callers never defend against a missing method. */
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

/**
 * A complete tool, generic over its parsed INPUT type (ToolDef is the
 * schema-first authoring shape). The seven defaultable members are always
 * present — callers never defend against a missing method.
 */
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

/** The readonly tool list every consumer passes around. */
export type Tools = readonly Tool[]

/** Both accepted annotation styles resolve: a zod schema as the first
 *  generic yields its output type; anything else IS the input type. */
export type ToolInputOf<T> = T extends ZodType ? ZodOutput<T> : T

/**
 * The property key stamped on default-supplied methods. The key identity
 * is the contract (non-enumerable and configurable, so it survives object
 * spread but never serialises); the literal value is not.
 */
export const TOOL_DEFAULT_MARKER = '__mercuryToolDefault'

/** True when a function was supplied by the buildTool defaults. */
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

/**
 * Fill the seven defaultable members with fail-closed defaults and return
 * a complete tool. A definition's own member always wins; the constructed
 * type preserves the definition's declared types, arity and
 * optional-presence exactly (the defaults' parameters are optional so both
 * zero-argument and full-argument call sites type-check).
 *
 * Defaults: enabled; NOT concurrency-safe; NOT read-only; NOT
 * destructive; no tool-level permission verdict (defer to the generic
 * permission system); a MARKED empty classifier projection (the
 * fail-closed guard tells "never opted in or out" apart from a deliberate
 * empty projection by that marker); and the tool's own name as its
 * user-facing name.
 */
export function buildTool<D extends ToolDef<any, any, any>>(def: D): D & ToolDefaults {
  const tool = {
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    // A tool without its own ladder ALLOWS its input: the decision chain's
    // rule stages (deny/ask rules, the kill-switch, the mode wrapper) run
    // around this verdict, so the default only decides what a rule-less
    // home sees — a read of the task list or a glob never asks on its own.
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

/**
 * Drop hook-progress entries from a progress-message list; an entry with
 * no payload at all survives (the predicate tests the payload's
 * discriminant, never requires one).
 */
export function filterToolProgressMessages(
  progressMessages: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
  return progressMessages.filter(
    message =>
      (message.data as { type?: string } | undefined)?.type !== 'hook_progress',
  ) as ProgressMessage<ToolProgressData>[]
}

/** Name-or-alias match — lookups by name must accept aliases. */
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  if (tool.name === name) return true
  return tool.aliases?.includes(name) ?? false
}

/** Find a tool by name or alias. */
export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(tool => toolMatchesName(tool, name))
}

/** Total user-facing-name lookup. Namers receive wire or persisted input
 *  that may predate schema validation (transcript re-render and resume
 *  replay exactly this path), so a namer throwing on a malformed value
 *  degrades to the fallback name instead of taking the render down. An
 *  empty-string return is meaningful (chrome opt-out) and passes through. */
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

/** A string-valued field of a tool input that may be anything the wire
 *  delivered (the streaming block-start placeholder `{}`, `null`, a partial
 *  object, a wrong-typed value). Undefined unless the field is a string. */
export function stringInputField(input: unknown, field: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

const loggedClassifierThrows = new Set<string>()

/** Total search/read classification. Undefined when the tool is absent,
 *  carries no classifier of its own, or its classifier throws — a
 *  classifier is transcript decoration, so its failure means "render the
 *  row uncollapsed", never an unmounted view. The throw is logged once per
 *  tool name. */
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
