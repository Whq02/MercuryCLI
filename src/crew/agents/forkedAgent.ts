import { randomUUID } from 'node:crypto'
import type { UUID } from 'node:crypto'

import type { QuerySource } from '../../engine/requests/querySource.js'
import type { Terminal } from '../../engine/turn-entry/transitions.js'
import type { CanUseToolFn } from '../../tools/kit/tool.js'
import { accumulateUsage, updateUsage } from '../../models/roads/anthropic/cacheAndUsage.js'
import { EMPTY_USAGE } from '../../engine/request-parts/emptyUsage.js'
import { rosterOwnerFromToolUseContext } from '../../engine/run-owner/resolveOwner.js'
import type { AppState } from '../../screen/app-state/AppStateStore.js'
import { advanceToolCallChain, type ToolUseContext } from '../../tools/kit/tool.js'
import { withAllowedCommandRules } from '../../tools/crewmate/crewmatePermissionPosture.js'
import { MERCURY_CREW_AGENT } from '../../tools/crewmate/built-in/mercuryCrewAgent.js'
import type { AgentDefinition } from './agentDefinition.js'
import type { AgentId } from '../../sessions/transcripts/ids.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { NonNullableUsage } from '../../engine/requests/apiCallLogging.js'
import type { ApiMessageDeltaUsage, ApiStreamEvent } from '../../engine/message-shapes/wire.js'
import type { PromptCommand } from '../../commands/catalogue/commands.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { cloneFileStateCache, type FileStateCache } from '../../platform/files/fileStateCache.js'
import { createChildAbortController } from '../../platform/async/abortController.js'
import type { TurnAnswerContext } from '../../engine/turn-entry/turnAnswerContext.js'
import { createUserMessage, extractTextContent, getLastAssistantMessage } from '../../engine/messages/messages.js'
import { parseToolListFromCLI } from '../../permissions/rules/permissionSetup.js'
import { recordSidechainTranscript, writtenChainTail } from '../../sessions/transcripts/sessionStorage.js'
import { settledSidechainMessages } from '../../sessions/transcripts/settledSidechainMessages.js'
import { closeCrewmateTranscript } from '../../sessions/transcripts/writer.js'
import type { SystemPrompt } from '../../engine/system-prompt/systemPromptType.js'
import { cloneContentReplacementState, type ContentReplacementState } from '../../engine/tool-dispatch/toolResultStorage.js'
import { createAgentId } from '../../platform/primitives/uuid.js'
import type { LegacyTurnYield } from '../../engine/loop/project-legacy.js'


export type CacheSafeParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
  postFoldCarry?: Message[]
}

type ChildContextOverrides = {
  readFileState?: FileStateCache
  contentReplacementState?: ContentReplacementState
  abortController?: AbortController
  shareAbortController?: boolean
  getAppState?: () => AppState
  setAppState?: (f: (prev: AppState) => AppState) => void
  shareSetAppState?: boolean
  setResponseLength?: (f: (prev: number) => number) => void
  setSDKStatus?: ToolUseContext['setSDKStatus']
  shareSetResponseLength?: boolean
  options?: ToolUseContext['options']
  messages?: Message[]
  agentId?: AgentId
  agentType?: string
  standingRule?: string
  requireCanUseTool?: boolean
  alwaysCallCanUseTool?: boolean
}

export type ForkedAgentParams = {
  promptMessages: Message[]
  cacheSafeParams: CacheSafeParams
  canUseTool: CanUseToolFn
  querySource: QuerySource
  forkLabel: string
  overrides?: ChildContextOverrides
  maxOutputTokens?: number
  maxTurns?: number
  onMessage?: (message: Message) => void
  onStreamEvent?: (event: ApiStreamEvent) => void
  skipTranscript?: boolean
  skipCacheWrite?: boolean
}

type ForkedAgentResult = {
  messages: Message[]
  totalUsage: NonNullableUsage
  terminal: Terminal | undefined
}

type PreparedForkedContext = {
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

export function createCacheSafeParams(hookContext: TurnAnswerContext): CacheSafeParams {
  return {
    systemPrompt: hookContext.systemPrompt,
    userContext: hookContext.userContext,
    systemContext: hookContext.systemContext,
    toolUseContext: hookContext.toolUseContext,
    forkContextMessages: hookContext.messages,
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
  const skillContent = extractTextContent(blocks, '\n')
  const allowedTools = parseToolListFromCLI(command.allowedTools ?? [])
  const modifiedGetAppState = createGetAppStateWithAllowedTools(context.getAppState, allowedTools)
  const activeAgents = context.options.agentDefinitions.activeAgents
  const baseAgent =
    (command.agent ? activeAgents.find(agent => agent.agentType === command.agent) : undefined) ??
    activeAgents.find(agent => agent.agentType === MERCURY_CREW_AGENT.agentType) ??
    activeAgents[0]
  if (baseAgent === undefined) {
    throw new Error('No agent definition is available to run this forked command.')
  }
  const promptMessages: Message[] = [createUserMessage({ content: skillContent })]
  return {
    skillContent,
    modifiedGetAppState,
    baseAgent,
    promptMessages,
  }
}

export function extractResultText(messages: Message[], defaultText: string = 'Execution completed.'): string {
  const last = getLastAssistantMessage(messages)
  if (!last) return defaultText
  const text = extractTextContent(last.message.content, '\n')
  return text.length > 0 ? text : defaultText
}


export function createChildContext(
  parentContext: ToolUseContext,
  overrides?: ChildContextOverrides,
): ToolUseContext {
  const readFileState = cloneFileStateCache(overrides?.readFileState ?? parentContext.readFileState)
  const contentReplacementState =
    overrides?.contentReplacementState !== undefined
      ? overrides.contentReplacementState
      : parentContext.contentReplacementState !== undefined
        ? cloneContentReplacementState(parentContext.contentReplacementState)
        : undefined
  const abortController =
    overrides?.abortController ??
    (overrides?.shareAbortController === true
      ? parentContext.abortController
      : createChildAbortController(parentContext.abortController))
  const getAppState =
    overrides?.getAppState ??
    (overrides?.shareAbortController === true
      ? parentContext.getAppState
      : () => {
          const state = parentContext.getAppState()
          if (state.toolPermissionContext.shouldAvoidPermissionPrompts === true) {
            return state
          }
          return {
            ...state,
            toolPermissionContext: {
              ...state.toolPermissionContext,
              shouldAvoidPermissionPrompts: true,
            },
          }
        })
  const setAppState =
    overrides?.setAppState ??
    (overrides?.shareSetAppState ? parentContext.setAppState : () => {})
  const setAppStateForTasks = parentContext.setAppStateForTasks ?? parentContext.setAppState
  const setResponseLength =
    overrides?.setResponseLength ??
    (overrides?.shareSetResponseLength ? parentContext.setResponseLength : () => {})

  return {
    options: overrides?.options ?? parentContext.options,
    startTurn: parentContext.startTurn,
    abortController,
    readFileState,
    getAppState,
    setAppState,
    setAppStateForTasks,
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    discoveredSkillNames: new Set<string>(),
    toolDecisions: undefined,
    contentReplacementState,
    userModifiedInput: parentContext.userModifiedInput,
    setInProgressToolUseIDs: () => {},
    setSDKStatus: overrides?.setSDKStatus,
    setResponseLength,
    updateFileHistoryState: () => {},
    messages: overrides?.messages ?? parentContext.messages,
    agentId: overrides?.agentId ?? createAgentId(),
    agentType: overrides?.agentType,
    agentKind: parentContext.agentKind,
    callChain: advanceToolCallChain(parentContext, randomUUID, 'fork'),
    fileReadingLimits: parentContext.fileReadingLimits,
    standingRule: overrides?.standingRule,
    requireCanUseTool: overrides?.requireCanUseTool,
    alwaysCallCanUseTool: overrides?.alwaysCallCanUseTool ?? parentContext.alwaysCallCanUseTool,
  }
}


function usageOf(event: unknown): ApiMessageDeltaUsage | undefined {
  const usage = (event as { usage?: ApiMessageDeltaUsage } | undefined)?.usage
  return usage && typeof usage === 'object' ? usage : undefined
}

type ForkUsageFold = { total: NonNullableUsage; open: NonNullableUsage | null }
export const EMPTY_FORK_USAGE_FOLD: ForkUsageFold = { total: EMPTY_USAGE, open: null }
export function foldForkUsageEvent(
  fold: ForkUsageFold,
  event: { type?: string; usage?: unknown; message?: { usage?: unknown } },
): ForkUsageFold {
  if (event.type === 'message_start') {
    return { total: fold.total, open: updateUsage(EMPTY_USAGE, usageOf(event.message)) }
  }
  if (event.type === 'message_delta') {
    return { total: fold.total, open: updateUsage(fold.open ?? EMPTY_USAGE, usageOf(event)) }
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
    forkLabel,
    overrides,
    maxOutputTokens,
    maxTurns,
    onMessage,
    onStreamEvent,
    skipTranscript,
    skipCacheWrite,
  } = params
  const { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages } =
    cacheSafeParams

  const startTime = Date.now()
  const childContext: ToolUseContext = {
    ...createChildContext(toolUseContext, overrides),
    rosterOwner: rosterOwnerFromToolUseContext(toolUseContext),
  }
  const messages: Message[] = [...forkContextMessages, ...promptMessages]
  const collectedMessages: Message[] = []
  let usageFold: ForkUsageFold = EMPTY_FORK_USAGE_FOLD
  let terminal: Terminal | undefined
  let transcriptAgentId: AgentId | undefined
  let chainTail: UUID | undefined

  try {
    if (!skipTranscript) {
      transcriptAgentId = createAgentId(forkLabel)
      const initialMessages: Message[] = [
        ...forkContextMessages.map(row => ({ ...row, replayOf: row.uuid })),
        ...promptMessages,
      ]
      try {
        await recordSidechainTranscript(initialMessages, transcriptAgentId)
        chainTail = writtenChainTail(initialMessages)
      } catch (error) {
        logForDebugging(`forkedAgent(${forkLabel}): initial transcript record failed: ${error}`)
      }
    }

    const rawStream = toolUseContext.startTurn({
      messages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool,
      toolUseContext: childContext,
      querySource,
      maxOutputTokensOverride: maxOutputTokens,
      maxTurns,
      skipCacheWrite,
    })

    async function* captureTerminal(
      source: ReturnType<ToolUseContext['startTurn']>,
    ): AsyncGenerator<LegacyTurnYield, void> {
      terminal = yield* source
    }

    for await (const item of settledSidechainMessages(captureTerminal(rawStream))) {
      if (item.type === 'stream_event') {
        usageFold = foldForkUsageEvent(usageFold, item.event)
        onStreamEvent?.(item.event)
        continue
      }
      if (item.type === 'stream_request_start' || item.type === 'tombstone') {
        continue
      }
      collectedMessages.push(item)
      logForDebugging(`forkedAgent(${forkLabel}): ${item.type} message`)
      onMessage?.(item)
      if (
        transcriptAgentId !== undefined &&
        (item.type === 'assistant' || item.type === 'user' || item.type === 'progress')
      ) {
        try {
          await recordSidechainTranscript([item], transcriptAgentId, chainTail)
          chainTail = writtenChainTail([item], chainTail)
        } catch (error) {
          logForDebugging(`forkedAgent(${forkLabel}): transcript append failed: ${error}`)
        }
      }
    }

    const totalUsage = settleForkUsageFold(usageFold)
    const elapsedMs = Date.now() - startTime
    const typeList = collectedMessages.map(message => message.type).join(', ')
    logForDebugging(
      `forkedAgent(${forkLabel}): done in ${elapsedMs}ms — ${collectedMessages.length} message(s) [${typeList}]; input=${totalUsage.input_tokens} output=${totalUsage.output_tokens} cache_create=${totalUsage.cache_creation_input_tokens} cache_read=${totalUsage.cache_read_input_tokens}`,
    )
    return {
      messages: collectedMessages,
      totalUsage,
      terminal,
    }
  } finally {
    childContext.readFileState.clear()
    messages.length = 0
    if (transcriptAgentId !== undefined) {
      closeCrewmateTranscript(transcriptAgentId)
    }
  }
}
