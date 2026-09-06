import { randomUUID } from 'node:crypto'
import type { EffortValue } from './effort.js'
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


export type CacheSafeParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
  parentQuerySource?: QuerySource
}

export type SubagentContextOverrides = {
  readFileState?: FileStateCache
  contentReplacementState?: ContentReplacementState
  abortController?: AbortController
  shareAbortController?: boolean
  getAppState?: () => AppState
  setAppState?: (f: (prev: AppState) => AppState) => void
  shareSetAppState?: boolean
  setResponseLength?: (f: (prev: number) => number) => void
  shareSetResponseLength?: boolean
  options?: ToolUseContext['options']
  messages?: Message[]
  agentId?: AgentId
  agentType?: string
  criticalSystemReminder_EXPERIMENTAL?: string
  requireCanUseTool?: boolean
}

export type ForkedAgentParams = {
  promptMessages: Message[]
  cacheSafeParams: CacheSafeParams
  canUseTool: CanUseToolFn
  querySource: QuerySource
  forkLabel: string
  overrides?: SubagentContextOverrides
  maxOutputTokens?: number
  maxTurns?: number
  onMessage?: (message: Message) => void
  onStreamEvent?: (event: unknown) => void
  skipTranscript?: boolean
  skipCacheWrite?: boolean
  effortMessage?: EffortValue
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


let lastCacheSafeParams: CacheSafeParams | null = null

export function saveCacheSafeParams(params: CacheSafeParams | null): void {
  lastCacheSafeParams = params
}

export function getLastCacheSafeParams(): CacheSafeParams | null {
  return lastCacheSafeParams
}

export function createCacheSafeParams(hookContext: REPLHookContext): CacheSafeParams {
  return {
    systemPrompt: hookContext.systemPrompt,
    userContext: hookContext.userContext,
    systemContext: hookContext.systemContext,
    toolUseContext: hookContext.toolUseContext,
    forkContextMessages: hookContext.messages,
    ...(hookContext.querySource !== undefined ? { parentQuerySource: hookContext.querySource } : {}),
  }
}


const sentRequests = new Map<string, Message[]>()
const SENT_REQUESTS_CAP = 32

export function recordSentRequest(ownerKey: string, messages: readonly Message[]): void {
  sentRequests.delete(ownerKey)
  sentRequests.set(ownerKey, [...messages])
  while (sentRequests.size > SENT_REQUESTS_CAP) {
    const oldest = sentRequests.keys().next().value
    if (oldest === undefined) break
    sentRequests.delete(oldest)
  }
}

export function lastSentRequestFor(ownerKey: string): Message[] | null {
  return sentRequests.get(ownerKey) ?? null
}

export function resetSentRequestsForTests(): void {
  sentRequests.clear()
}

export function continuationOfSentRequest(
  sent: readonly Message[] | null,
  current: readonly Message[],
): { sent: Message[]; tail: Message[] } | null {
  if (sent === null || sent.length === 0) return null
  const present = new Set(current.map(row => row.uuid))
  let index = 0
  for (const row of sent) {
    const head = current[index]
    if (head !== undefined && head.uuid === row.uuid) {
      index++
      continue
    }
    const minted = row.type === 'user' && row.isMeta === true && !present.has(row.uuid)
    if (minted) continue
    return null
  }
  return { sent: [...sent], tail: current.slice(index) }
}


export function createGetAppStateWithAllowedTools(
  baseGetAppState: () => AppState,
  allowedTools: string[],
): () => AppState {
  if (allowedTools.length === 0) return baseGetAppState
  return () => withAllowedCommandRules(baseGetAppState(), allowedTools)
}


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

export function extractResultText(messages: Message[], defaultText: string = 'Execution completed.'): string {
  const last = getLastAssistantMessage(messages)
  if (!last) return defaultText
  const text = extractTextContent(last.message.content, '\n')
  return text.length > 0 ? text : defaultText
}


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


function usageOf(event: unknown): Partial<NonNullableUsage> | undefined {
  const usage = (event as { usage?: Partial<NonNullableUsage> } | undefined)?.usage
  return usage && typeof usage === 'object' ? usage : undefined
}

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
    onStreamEvent,
    skipTranscript,
    skipCacheWrite,
    effortMessage,
  } = params
  const startedAt = Date.now()
  const context: ToolUseContext = {
    ...createSubagentContext(cacheSafeParams.toolUseContext, overrides),
    rosterOwner: rosterOwnerFromToolUseContext(cacheSafeParams.toolUseContext),
  }
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
      effortMessage,
      cacheTtlSource: cacheSafeParams.parentQuerySource,
    })) {
      if (item.type === 'stream_event') {
        fold = foldForkUsageEvent(fold, item.event as { type?: string; usage?: unknown; message?: { usage?: unknown } })
        onStreamEvent?.(item.event)
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
