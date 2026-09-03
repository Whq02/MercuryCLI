import { randomUUID } from 'node:crypto'
import type { UUID } from 'node:crypto'

import type { QuerySource } from '../constants/querySource.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { query } from '../query.js'
import { accumulateUsage, updateUsage } from '../services/providers/anthropic/cacheAndUsage.js'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import { rosterOwnerFromToolUseContext } from '../services/run/resolveOwner.js'
import type { AppState } from '../state/AppStateStore.js'
import type { ToolUseContext } from '../Tool.js'
import { withAllowedCommandRules } from '../tools/AgentTool/agentPermissionPosture.js'
import { GENERAL_PURPOSE_AGENT } from '../tools/AgentTool/built-in/generalPurposeAgent.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { AgentId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import type { NonNullableUsage } from '../services/api/logging.js'
import type { PromptCommand } from '../commands.js'
import { logForDebugging } from './debug.js'
import { cloneFileStateCache, type FileStateCache } from './fileStateCache.js'
import { createChildAbortController } from './abortController.js'
import type { REPLHookContext } from './hooks/postSamplingHooks.js'
import { createUserMessage, extractTextContent, getLastAssistantMessage } from './messages.js'
import { createDenialTrackingState } from './permissions/denialTracking.js'
import { parseToolListFromCLI } from './permissions/permissionSetup.js'
import { recordSidechainTranscript } from './sessionStorage.js'
import type { SystemPrompt } from './systemPromptType.js'
import { cloneContentReplacementState, type ContentReplacementState } from './toolResultStorage.js'
import { createAgentId } from './uuid.js'

/**
 * Forked agents: side loops that reuse the main loop's cached prompt
 * prefix, and the isolated subagent context every subagent runs in.
 */

/**
 * Everything that must match the parent request for the provider cache to
 * hit. The thinking configuration rides inside the tool use context; setting
 * a maximum output token count clamps the thinking budget on older models
 * and so changes the cache key — only set one when cache sharing is not a
 * goal.
 */
export type CacheSafeParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  /** The parent's context messages. */
  forkContextMessages: Message[]
}

export type SubagentContextOverrides = {
  readFileState?: FileStateCache
  contentReplacementState?: ContentReplacementState
  abortController?: AbortController
  /** Marks an interactive subagent that may show UI: shares the parent's abort controller AND app-state accessor. */
  shareAbortController?: boolean
  getAppState?: () => AppState
  setAppState?: (f: (prev: AppState) => AppState) => void
  /** Share the parent's state setter (and its denial tracker) instead of a no-op. */
  shareSetAppState?: boolean
  setResponseLength?: (f: (prev: number) => number) => void
  /** Share the parent's response-length setter instead of a no-op. */
  shareSetResponseLength?: boolean
  options?: ToolUseContext['options']
  messages?: Message[]
  agentId?: AgentId
  agentType?: string
  criticalSystemReminder_EXPERIMENTAL?: string
  /** Speculative execution rewrites overlay file paths, so the permission check must always run. */
  requireCanUseTool?: boolean
}

export type ForkedAgentParams = {
  promptMessages: Message[]
  cacheSafeParams: CacheSafeParams
  canUseTool: CanUseToolFn
  querySource: QuerySource
  /** Analytics label; also seeds the side-transcript agent id. */
  forkLabel: string
  overrides?: SubagentContextOverrides
  maxOutputTokens?: number
  maxTurns?: number
  onMessage?: (message: Message) => void
  skipTranscript?: boolean
  skipCacheWrite?: boolean
}

export type ForkedAgentResult = {
  messages: Message[]
  totalUsage: NonNullableUsage
}

export type PreparedForkedContext = {
  skillContent: string
  modifiedGetAppState: () => AppState
  baseAgent: AgentDefinition
  promptMessages: Message[]
}

// ---------------------------------------------------------------------------
// The most recent cache-safe parameters (written after each turn)
// ---------------------------------------------------------------------------

let lastCacheSafeParams: CacheSafeParams | null = null

export function saveCacheSafeParams(params: CacheSafeParams | null): void {
  lastCacheSafeParams = params
}

export function getLastCacheSafeParams(): CacheSafeParams | null {
  return lastCacheSafeParams
}

/** Callers override individual fields by spreading the result. */
export function createCacheSafeParams(hookContext: REPLHookContext): CacheSafeParams {
  return {
    systemPrompt: hookContext.systemPrompt,
    userContext: hookContext.userContext,
    systemContext: hookContext.systemContext,
    toolUseContext: hookContext.toolUseContext,
    forkContextMessages: hookContext.messages,
  }
}

// ---------------------------------------------------------------------------
// Permission grants
// ---------------------------------------------------------------------------

/** Adds the tools to the always-allow command rules (the one merge law,
 *  agentPermissionPosture.withAllowedCommandRules); identity for an empty list. */
export function createGetAppStateWithAllowedTools(
  baseGetAppState: () => AppState,
  allowedTools: string[],
): () => AppState {
  if (allowedTools.length === 0) return baseGetAppState
  return () => withAllowedCommandRules(baseGetAppState(), allowedTools)
}

// ---------------------------------------------------------------------------
// Forked commands / skills
// ---------------------------------------------------------------------------

export async function prepareForkedCommandContext(
  command: PromptCommand & { name?: string },
  args: string,
  context: ToolUseContext,
): Promise<PreparedForkedContext> {
  const blocks = await command.getPromptForCommand(args, context)
  const content = extractTextContent(blocks, '\n')
  const allowedTools = parseToolListFromCLI(command.allowedTools ?? [])
  const getAppState = createGetAppStateWithAllowedTools(context.getAppState, allowedTools)
  const active = context.options.agentDefinitions.activeAgents
  const agent =
    (command.agent ? active.find(candidate => candidate.agentType === command.agent) : undefined) ??
    active.find(candidate => candidate.agentType === GENERAL_PURPOSE_AGENT.agentType) ??
    active[0]
  if (!agent) {
    throw new Error('No agent definition is available to run this forked command.')
  }
  const messages: Message[] = [createUserMessage({ content })]
  return { skillContent: content, modifiedGetAppState: getAppState, baseAgent: agent, promptMessages: messages }
}

/** The last assistant message's text, or the default when there is none. */
export function extractResultText(messages: Message[], defaultText: string = 'Execution completed.'): string {
  const last = getLastAssistantMessage(messages)
  if (!last) return defaultText
  const text = extractTextContent(last.message.content, '\n')
  return text.length > 0 ? text : defaultText
}

// ---------------------------------------------------------------------------
// Subagent contexts
// ---------------------------------------------------------------------------

/**
 * Every piece of mutable state is a private copy or an inert stub unless a
 * caller opts in, so nothing a subagent does leaks into the parent. Two
 * deliberate exceptions: the task-registration setter always reaches the
 * root store (otherwise background shell tasks are never registered and
 * never killed) and the attribution updater is shared because it is scoped
 * and functional.
 */
export function createSubagentContext(parentContext: ToolUseContext, overrides: SubagentContextOverrides = {}): ToolUseContext {
  const shareWithParent = overrides.shareAbortController === true
  const readFileState = cloneFileStateCache(overrides.readFileState ?? parentContext.readFileState)
  const contentReplacementState =
    overrides.contentReplacementState ??
    (parentContext.contentReplacementState ? cloneContentReplacementState(parentContext.contentReplacementState) : undefined)
  const abortController =
    overrides.abortController ??
    (shareWithParent ? parentContext.abortController : createChildAbortController(parentContext.abortController))
  const getAppState =
    overrides.getAppState ??
    (shareWithParent
      ? parentContext.getAppState
      : () => {
          const state = parentContext.getAppState()
          if (state.toolPermissionContext.shouldAvoidPermissionPrompts) return state
          return {
            ...state,
            toolPermissionContext: { ...state.toolPermissionContext, shouldAvoidPermissionPrompts: true },
          }
        })
  const setAppState = overrides.setAppState ?? (overrides.shareSetAppState ? parentContext.setAppState : () => {})
  // An asynchronous subagent with a no-op setter still needs its denial
  // counter to accumulate across retries.
  const stateSetterShared = overrides.setAppState !== undefined || overrides.shareSetAppState === true
  const localDenialTracking = stateSetterShared ? parentContext.localDenialTracking : createDenialTrackingState()

  return {
    options: overrides.options ?? parentContext.options,
    abortController,
    readFileState,
    getAppState,
    setAppState,
    setAppStateForTasks: parentContext.setAppStateForTasks ?? parentContext.setAppState,
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    discoveredSkillNames: new Set<string>(),
    toolDecisions: undefined,
    contentReplacementState,
    userModifiedInput: parentContext.userModifiedInput,
    setInProgressToolUseIDs: () => {},
    setResponseLength:
      overrides.setResponseLength ?? (overrides.shareSetResponseLength ? parentContext.setResponseLength : () => {}),
    updateFileHistoryState: () => {},
    updateAttributionState: parentContext.updateAttributionState,
    localDenialTracking,
    messages: overrides.messages ?? parentContext.messages,
    agentId: overrides.agentId ?? createAgentId(),
    agentType: overrides.agentType,
    queryTracking: {
      chainId: randomUUID(),
      depth: (parentContext.queryTracking?.depth ?? -1) + 1,
    },
    fileReadingLimits: parentContext.fileReadingLimits,
    criticalSystemReminder_EXPERIMENTAL: overrides.criticalSystemReminder_EXPERIMENTAL,
    requireCanUseTool: overrides.requireCanUseTool,
  }
}

// ---------------------------------------------------------------------------
// The forked loop
// ---------------------------------------------------------------------------

function usageOf(event: unknown): Partial<NonNullableUsage> | undefined {
  const usage = (event as { usage?: Partial<NonNullableUsage> } | undefined)?.usage
  return usage && typeof usage === 'object' ? usage : undefined
}

/** The fork's usage fold — ONE response at a time, the way the engine
 *  folds the same wire (QueryEngine's stream_event arm): message_start
 *  SEEDS the response's usage (the input side — uncached, cache-read,
 *  cache-write — arrives real there and reappears as explicit 0 in every
 *  later delta), message_delta REPLACES cumulative fields under
 *  updateUsage's greater-than-zero guard, message_stop ACCUMULATES the
 *  settled response into the total. The base folded message_delta frames
 *  alone with no guard, so on the Anthropic lane a /console ask re-sending
 *  a 45,000-token parent context reported 0 prompt tokens and the cache-hit
 *  badge could never light — cache sharing with the parent prefix being
 *  the fork's stated purpose (FN-018 rank 8). PURE — the prover drives it. */
export type ForkUsageFold = { total: NonNullableUsage; open: NonNullableUsage | null }
export const EMPTY_FORK_USAGE_FOLD: ForkUsageFold = { total: EMPTY_USAGE, open: null }
export function foldForkUsageEvent(
  fold: ForkUsageFold,
  event: { type?: string; usage?: unknown; message?: { usage?: unknown } },
): ForkUsageFold {
  if (event.type === 'message_start') {
    return { total: fold.total, open: updateUsage(EMPTY_USAGE, usageOf(event.message) as never) }
  }
  if (event.type === 'message_delta') {
    return { total: fold.total, open: updateUsage(fold.open ?? EMPTY_USAGE, usageOf(event) as never) }
  }
  if (event.type === 'message_stop') {
    return fold.open === null ? fold : { total: accumulateUsage(fold.total, fold.open), open: null }
  }
  return fold
}
/** The total once the stream ends — a response a lane never closed with
 *  message_stop still counts. */
export function settleForkUsageFold(fold: ForkUsageFold): NonNullableUsage {
  return fold.open === null ? fold.total : accumulateUsage(fold.total, fold.open)
}

export async function runForkedAgent(params: ForkedAgentParams): Promise<ForkedAgentResult> {
  const {
    promptMessages,
    cacheSafeParams,
    canUseTool,
    querySource,
    forkLabel: label,
    overrides,
    maxOutputTokens,
    maxTurns,
    onMessage,
    skipTranscript,
    skipCacheWrite,
  } = params
  const startedAt = Date.now()
  const context: ToolUseContext = {
    ...createSubagentContext(cacheSafeParams.toolUseContext, overrides),
    // A fork rides its parent's context messages, so its requests ride the
    // parent's frozen tool roster too — the tools array byte-for-byte, the
    // prefix every parent thinking block is bound to and the cache the fork
    // exists to share. Its own owner stays its own (attribution, the drop
    // classifier).
    rosterOwner: rosterOwnerFromToolUseContext(cacheSafeParams.toolUseContext),
  }
  // The parent's messages followed by the prompt. Incomplete tool calls are
  // NOT filtered here: filtering drops a whole assistant message when its
  // tool batch is partial and strands the paired results (a request the
  // provider refuses); the pairing pass downstream repairs unpaired uses for
  // both threads alike, so the cached prefix still hits.
  const messages: Message[] = [...cacheSafeParams.forkContextMessages, ...promptMessages]
  const collected: Message[] = []
  let fold: ForkUsageFold = EMPTY_FORK_USAGE_FOLD
  const agentId = skipTranscript ? undefined : createAgentId(label)
  let lastRecordedUuid: UUID | undefined
  if (!skipTranscript) {
    try {
      await recordSidechainTranscript(messages, agentId)
      const last = messages[messages.length - 1] as { uuid?: UUID } | undefined
      lastRecordedUuid = last?.uuid
    } catch (err) {
      logForDebugging(`forkedAgent(${label}): initial transcript record failed: ${String(err)}`)
    }
  }
  try {
    for await (const item of query({
      messages,
      systemPrompt: cacheSafeParams.systemPrompt,
      userContext: cacheSafeParams.userContext,
      systemContext: cacheSafeParams.systemContext,
      canUseTool,
      toolUseContext: context,
      querySource,
      maxOutputTokensOverride: maxOutputTokens,
      maxTurns,
      skipCacheWrite,
    })) {
      if (item.type === 'stream_event') {
        fold = foldForkUsageEvent(fold, item.event as { type?: string; usage?: unknown; message?: { usage?: unknown } })
        continue
      }
      if (item.type === 'stream_request_start') continue
      const message = item as Message
      logForDebugging(`forkedAgent(${label}): ${message.type} message`)
      collected.push(message)
      onMessage?.(message)
      if (!skipTranscript && (message.type === 'assistant' || message.type === 'user' || message.type === 'progress')) {
        try {
          await recordSidechainTranscript([message], agentId, lastRecordedUuid)
        } catch (err) {
          logForDebugging(`forkedAgent(${label}): transcript append failed: ${String(err)}`)
        }
        if (message.type !== 'progress') {
          lastRecordedUuid = (message as { uuid?: UUID }).uuid ?? lastRecordedUuid
        }
      }
    }
  } finally {
    // A real memory-release step: the cloned read cache and the copied
    // context message list can be large.
    context.readFileState.clear()
    messages.length = 0
  }
  const usage = settleForkUsageFold(fold)
  const durationMs = Date.now() - startedAt
  logForDebugging(
    `forkedAgent(${label}): done in ${durationMs}ms — ${collected.length} message(s) [${collected.map(m => m.type).join(', ')}]; ` +
      `input=${usage.input_tokens} output=${usage.output_tokens} cache_create=${usage.cache_creation_input_tokens} cache_read=${usage.cache_read_input_tokens}`,
  )
  return { messages: collected, totalUsage: usage }
}
