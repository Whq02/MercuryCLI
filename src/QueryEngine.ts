import { randomUUID } from 'node:crypto'
import stripAnsi from 'strip-ansi'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from './bootstrap/state.js'
import type { Command } from './commands.js'
import { LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from './constants/xml.js'
import { armWorkerParentWatch } from './daemon/workerParentWatch.js'
import type { SDKMessage } from './entrypoints/agentSdkTypes.js'
import { MERCURY_IDENTITY_FLOOR } from './prompt/mercuryContract.js'
import { queryEvents } from './query.js'
import { legacyYieldsOf } from './run-core/project-legacy.js'
import type { QueryParams } from './run-core/turn-machine.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import { accumulateUsage, updateUsage } from './services/providers/anthropic/cacheAndUsage.js'
import { EMPTY_USAGE } from './services/api/logging.js'
import type { NonNullableUsage } from './services/api/logging.js'
import type { PermissionChannel, Tools, ToolUseContext } from './Tool.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/constants.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from './types/message.js'
import type { ApiStreamEvent, ContentBlockParam } from './types/wire.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { getGlobalConfig } from './utils/config.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import type { FileStateCache } from './utils/fileStateCache.js'
import { cloneFileStateCache } from './utils/fileStateCache.js'
import { fileHistoryEnabled, fileHistoryMakeSnapshot } from './utils/fileHistory.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { engageCommitGate } from './utils/hooks/commitGate.js'
import { registerForcedReadHook } from './utils/hooks/forcedReadHook.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { registerRunStopHook } from './utils/hooks/runStopHook.js'
import { registerWardsHook } from './utils/hooks/wardsHook.js'
import { getInMemoryErrors, logError } from './utils/log.js'
import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import { buildSystemInitMessage } from './utils/messages/systemInit.js'
import { getMainLoopModel } from './utils/model/model.js'
import { getModelUsage, getTotalAPIDuration, getTotalCostUSD } from './bootstrap/state.js'
import { notePrintPhase } from './utils/printPhases.js'
import { processUserInput } from './utils/processUserInput/processUserInput.js'
import { getSlashCommandToolSkills } from './commands.js'
import { ensureExtensionsLoaded } from './extensions/boot.js'
import { handleOrphanedPermission, isResultSuccessful, normalizeMessage } from './utils/queryHelpers.js'
import { fetchSystemPromptParts } from './utils/queryContext.js'
import { assertSingleRole } from './utils/workerRole.js'
import { flushSessionStorage, recordTranscript } from './utils/sessionStorage.js'
import { setCwd } from './utils/Shell.js'
import { flagEnv } from './substrate/flagRegistry.js'
import type { ThinkingConfig } from './utils/thinking.js'
import { shouldEnableThinkingByDefault } from './utils/thinking.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'

const DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES = 5

type CanUseTool = ToolUseContext extends never ? never : QueryParams['canUseTool']
type GetAppState = ToolUseContext['getAppState']
type SetAppState = ToolUseContext['setAppState']
type McpClients = ToolUseContext['options']['mcpClients']
type AgentDefinitions = ToolUseContext['options']['agentDefinitions']['activeAgents']

type SnipBoundaryCallback = (
  yieldedSystemMessage: Message,
  store: Message[],
) => { messages: Message[]; executed: boolean } | undefined

export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: McpClients
  agents: AgentDefinitions
  canUseTool: CanUseTool
  permissionChannel?: PermissionChannel
  getAppState: GetAppState
  setAppState: SetAppState
  readFileState: FileStateCache
  initialMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  replayUserMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  includePartialMessages?: boolean
  onLiveness?: () => void
  setSDKStatus?: ToolUseContext['setSDKStatus']
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
  snipBoundaryCallback?: SnipBoundaryCallback
}

type SdkPermissionDenial = {
  tool_name: string
  tool_use_id: string
  tool_input: Record<string, unknown>
}

const asSdk = (value: Record<string, unknown>): SDKMessage =>
  value as unknown as SDKMessage


function messageTextContent(message: Message): string | null {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  return null
}

function isLocalCommandOutputText(text: string): boolean {
  return (
    text.includes(LOCAL_COMMAND_STDOUT_TAG) || text.includes(LOCAL_COMMAND_STDERR_TAG)
  )
}

export class QueryEngine {
  readonly #config: QueryEngineConfig
  private readonly mutableMessages: Message[]
  readonly #readFileState: FileStateCache
  readonly #abortController: AbortController
  #userSpecifiedModel: string | undefined
  readonly #loadedNestedMemoryPaths = new Set<string>()
  readonly #discoveredSkillNames = new Set<string>()
  readonly #permissionDenials: SdkPermissionDenial[] = []
  #accumulatedUsage: NonNullableUsage = { ...EMPTY_USAGE }
  readonly #streamFoldedIds = new Set<string>()
  readonly #settledUsageById = new Map<string, NonNullableUsage>()
  #orphanedPermissionHandled = false
  #turnCounter = 1
  #recordCursor = 0
  #recordChain: Promise<string | null> = Promise.resolve(null)
  #structuredOutput: unknown

  constructor(config: QueryEngineConfig) {
    this.#config = config
    this.mutableMessages = [...(config.initialMessages ?? [])]
    this.#readFileState = config.readFileState
    this.#abortController = config.abortController ?? new AbortController()
    this.#userSpecifiedModel = config.userSpecifiedModel
  }

  interrupt(): void {
    this.#abortController.abort()
  }

  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  getReadFileState(): FileStateCache {
    return this.#readFileState
  }

  getSessionId(): string {
    return getSessionId()
  }

  setModel(model: string): void {
    this.#userSpecifiedModel = model
  }

  #recordDelta(turnMessages: Message[]): Promise<string | null> {
    const pending = turnMessages.slice(this.#recordCursor)
    this.#recordCursor = turnMessages.length
    if (pending.length === 0) return this.#recordChain
    this.#recordChain = this.#recordChain.then(hint =>
      recordTranscript(
        pending,
        undefined,
        (hint ?? undefined) as Parameters<typeof recordTranscript>[2],
        turnMessages,
      ).catch((error: unknown) => {
        logError(error)
        return null
      }),
    )
    return this.#recordChain
  }

  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean; mode?: 'prompt' | 'bash'; batchUuids?: string[] },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const config = this.#config
    this.#discoveredSkillNames.clear()
    setCwd(config.cwd)
    const persistenceDisabled = isSessionPersistenceDisabled()
    const turnStartedAt = Date.now()
    const eagerFlush = isEnvTruthy(process.env.MERCURY_EAGER_FLUSH)
    const errorWatermark = getInMemoryErrors().at(-1)

    const wrappedCanUseTool: CanUseTool = (async (
      tool: { name: string },
      input: Record<string, unknown>,
      toolUseContext: ToolUseContext,
      assistantMessage: AssistantMessage,
      toolUseID: string,
      forceDecision?: unknown,
    ) => {
      const decision = await (config.canUseTool as (...args: unknown[]) => Promise<{ behavior?: string }>)(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )
      if (decision?.behavior !== 'allow') {
        this.#permissionDenials.push({
          tool_name: tool.name,
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }
      return decision
    }) as CanUseTool

    const appStateSnapshot = config.getAppState()

    const resolvedModel = this.#userSpecifiedModel ?? getMainLoopModel()

    const thinkingConfig: ThinkingConfig =
      config.thinkingConfig ??
      (shouldEnableThinkingByDefault()
        ? ({ type: 'adaptive' } as ThinkingConfig)
        : ({ type: 'disabled' } as ThinkingConfig))

    const additionalWorkingDirectories = [
      ...appStateSnapshot.toolPermissionContext.additionalWorkingDirectories.keys(),
    ]
    headlessProfilerCheckpoint('before_getSystemPrompt')
    const promptParts = await fetchSystemPromptParts({
      tools: config.tools,
      mainLoopModel: resolvedModel,
      additionalWorkingDirectories,
      mcpClients: config.mcpClients,
      customSystemPrompt: config.customSystemPrompt,
      permissionMode: appStateSnapshot.toolPermissionContext.mode,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')

    let memoryMechanicsPrompt: string | null = null
    if (config.customSystemPrompt !== undefined && hasAutoMemPathOverride()) {
      memoryMechanicsPrompt = await loadMemoryPrompt()
    }

    const systemPromptSections: string[] =
      config.customSystemPrompt !== undefined
        ? [MERCURY_IDENTITY_FLOOR, config.customSystemPrompt]
        : [...promptParts.defaultSystemPrompt]
    if (memoryMechanicsPrompt) systemPromptSections.push(memoryMechanicsPrompt)
    if (config.appendSystemPrompt) systemPromptSections.push(config.appendSystemPrompt)
    const systemPrompt = asSystemPrompt(systemPromptSections)

    const sessionId = getSessionId()
    const hasSyntheticOutputTool = config.tools.some(
      tool => tool.name === SYNTHETIC_OUTPUT_TOOL_NAME,
    )
    if (config.jsonSchema && hasSyntheticOutputTool) {
      registerStructuredOutputEnforcement(config.setAppState, sessionId)
    }
    const forcedReadList = (flagEnv('MERCURY_FORCE_READ_FILES') ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)
    if (forcedReadList.length > 0) {
      registerForcedReadHook(config.setAppState, sessionId, forcedReadList)
    }
    registerWardsHook(config.setAppState, sessionId)
    registerRunStopHook(config.setAppState, sessionId)
    engageCommitGate(config.setAppState, getSessionId())
    assertSingleRole()
    armWorkerParentWatch()

    const buildContext = (messages: Message[], model: string): ToolUseContext => ({
      options: {
        commands: config.commands,
        debug: false,
        verbose: false,
        mainLoopModel: model,
        thinkingConfig,
        tools: config.tools,
        mcpClients: config.mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        ...(config.permissionChannel !== undefined ? { permissionChannel: config.permissionChannel } : {}),
        customSystemPrompt: config.customSystemPrompt,
        appendSystemPrompt: config.appendSystemPrompt,
        agentDefinitions: { activeAgents: config.agents ?? [], allAgents: [] },
        theme: getGlobalConfig().theme,
        maxBudgetUsd: config.maxBudgetUsd,
        querySource: 'sdk',
      },
      abortController: this.#abortController,
      readFileState: this.#readFileState,
      getAppState: config.getAppState,
      setAppState: config.setAppState,
      messages,
      setResponseLength: () => {},
      setInProgressToolUseIDs: () => {},
      updateFileHistoryState: updater => {
        config.setAppState(prev => {
          const next = updater(prev.fileHistory)
          return next === prev.fileHistory ? prev : { ...prev, fileHistory: next }
        })
      },
      updateAttributionState: updater => {
        config.setAppState(prev => {
          const next = updater(prev.attribution)
          return next === prev.attribution ? prev : { ...prev, attribution: next }
        })
      },
      handleElicitation: config.handleElicitation,
      setSDKStatus: config.setSDKStatus,
      discoveredSkillNames: this.#discoveredSkillNames,
      loadedNestedMemoryPaths: this.#loadedNestedMemoryPaths,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      dynamicSkillDirTriggers: new Set<string>(),
    })
    let toolUseContext = buildContext(this.mutableMessages, resolvedModel)

    if (config.orphanedPermission && !this.#orphanedPermissionHandled) {
      this.#orphanedPermissionHandled = true
      yield* handleOrphanedPermission(
        config.orphanedPermission,
        config.tools,
        this.mutableMessages,
        toolUseContext as Parameters<typeof handleOrphanedPermission>[3],
      )
    }

    const syntheticCallsBeforeTurn = this.#countSyntheticOutputCalls()

    const inputResult = await processUserInput({
      input: prompt,
      mode: options?.mode ?? 'prompt',
      setToolJSX: () => {},
      context: toolUseContext as Parameters<typeof processUserInput>[0]['context'],
      messages: this.mutableMessages,
      uuid: options?.uuid,
      ...(options?.batchUuids !== undefined ? { batchUuids: options.batchUuids } : {}),
      isMeta: options?.isMeta,
      querySource: 'sdk',
      canUseTool: wrappedCanUseTool,
    })

    this.mutableMessages.push(...inputResult.messages)
    let turnMessages: Message[] = [...this.mutableMessages]

    if (!persistenceDisabled && inputResult.messages.length > 0) {
      const recordPromise = this.#recordDelta(turnMessages)
      if (isBareMode()) {
        void recordPromise
      } else {
        await recordPromise
        if (eagerFlush) await flushSessionStorage()
      }
    } else {
      this.#recordCursor = turnMessages.length
    }

    const pendingReplays: Message[] = config.replayUserMessages
      ? inputResult.messages.filter(message => {
          if (message.type === 'user') {
            const userMessage = message as UserMessage & {
              isMeta?: boolean
              toolUseResult?: unknown
            }
            if (userMessage.isMeta === true) return false
            if (userMessage.toolUseResult !== undefined) return false
            const text = messageTextContent(message)
            if (text !== null && isLocalCommandOutputText(text)) return false
            return true
          }
          return (
            message.type === 'system' &&
            (message as { subtype?: string }).subtype === 'compact_boundary'
          )
        })
      : []

    if (inputResult.allowedTools && inputResult.allowedTools.length > 0) {
      config.setAppState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          alwaysAllowRules: {
            ...prev.toolPermissionContext.alwaysAllowRules,
            command: [
              ...new Set([
                ...(prev.toolPermissionContext.alwaysAllowRules.command ?? []),
                ...inputResult.allowedTools!,
              ]),
            ],
          },
        },
      }))
    }

    const effectiveModel = inputResult.model ?? resolvedModel
    toolUseContext = buildContext(turnMessages, effectiveModel)

    const buildResultEnvelope = (): Record<string, unknown> => {
      for (const [messageId, usage] of this.#settledUsageById) {
        if (this.#streamFoldedIds.has(messageId)) continue
        this.#streamFoldedIds.add(messageId)
        if (usage.input_tokens === 0 && usage.output_tokens === 0) continue
        this.#accumulatedUsage = accumulateUsage(this.#accumulatedUsage, usage)
      }
      notePrintPhase('settlement')
      return {
        duration_ms: Date.now() - turnStartedAt,
        duration_api_ms: getTotalAPIDuration(),
        session_id: getSessionId(),
        total_cost_usd: getTotalCostUSD(),
        usage: this.#accumulatedUsage,
        modelUsage: getModelUsage(),
        permission_denials: [...this.#permissionDenials],
        uuid: randomUUID(),
      }
    }

    headlessProfilerCheckpoint('before_skills_extensions')
    const [skills, loaded] = await Promise.all([
      getSlashCommandToolSkills(config.cwd),
      ensureExtensionsLoaded({ cwd: config.cwd }),
    ])
    const extensions = loaded.set.active.map(ext => ({ name: ext.manifest.name, path: ext.root, source: ext.entry.id }))
    headlessProfilerCheckpoint('after_skills_extensions')
    yield buildSystemInitMessage({
      tools: config.tools,
      mcpClients: config.mcpClients,
      model: effectiveModel,
      permissionMode: appStateSnapshot.toolPermissionContext.mode,
      commands: config.commands,
      agents: config.agents ?? [],
      skills,
      extensions,
    })
    headlessProfilerCheckpoint('system_message_yielded')
    notePrintPhase('assembly')

    if (!inputResult.shouldQuery) {
      for (const message of inputResult.messages) {
        if (message.type === 'user') {
          const text = messageTextContent(message)
          const isCompactSummary =
            (message as { isCompactSummary?: boolean }).isCompactSummary === true
          if ((text !== null && isLocalCommandOutputText(text)) || isCompactSummary) {
            const flags = message as { isMeta?: boolean; isVisibleInTranscriptOnly?: boolean }
            yield asSdk({
              type: 'user',
              message: {
                role: 'user',
                content: stripAnsi(text ?? ''),
              },
              parent_tool_use_id: null,
              session_id: getSessionId(),
              uuid: (message as { uuid?: string }).uuid,
              timestamp: (message as { timestamp?: string }).timestamp,
              isReplay: !isCompactSummary,
              ...(flags.isMeta === true || flags.isVisibleInTranscriptOnly === true
                ? { isSynthetic: true }
                : {}),
            })
          }
        } else if (
          message.type === 'system' &&
          (message as { subtype?: string }).subtype === 'local_command'
        ) {
          const content = (message as { content?: unknown }).content
          if (typeof content === 'string' && isLocalCommandOutputText(content)) {
            yield localCommandOutputToSDKAssistantMessage(
              content,
              (message as { uuid?: string }).uuid as Parameters<
                typeof localCommandOutputToSDKAssistantMessage
              >[1],
            )
          }
        } else if (
          message.type === 'system' &&
          (message as { subtype?: string }).subtype === 'compact_boundary'
        ) {
          const meta = (message as { compactMetadata?: never }).compactMetadata
          yield asSdk({
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: meta ? toSDKCompactMetadata(meta) : undefined,
            session_id: getSessionId(),
            uuid: (message as { uuid?: string }).uuid,
          })
        }
      }
      if (!persistenceDisabled) {
        await this.#recordDelta(turnMessages)
        if (eagerFlush) await flushSessionStorage()
      }
      yield asSdk({
        type: 'result',
        subtype: 'success',
        is_error: inputResult.commandRefused === true || inputResult.hookBlocked === true,
        num_turns: turnMessages.length - 1,
        result: inputResult.resultText ?? '',
        stop_reason: null,
        ...buildResultEnvelope(),
      })
      return
    }

    if (!persistenceDisabled && fileHistoryEnabled()) {
      const snapshots: Promise<void>[] = []
      for (const message of inputResult.messages) {
        if (message.type !== 'user') continue
        if ((message as { isMeta?: boolean }).isMeta === true) continue
        const uuid = (message as { uuid?: string }).uuid
        if (uuid) {
          snapshots.push(
            fileHistoryMakeSnapshot(
              toolUseContext.updateFileHistoryState,
              uuid as Parameters<typeof fileHistoryMakeSnapshot>[1],
            ).catch((error: unknown) => logError(error)),
          )
        }
      }
      await Promise.all(snapshots)
    }

    let currentUsage: NonNullableUsage = { ...EMPTY_USAGE }
    let currentStreamMessageId: string | null = null
    let capturedStopReason: string | null = null
    let acknowledgedReplays = false
    let firstRecordingDone = false

    const recordDelta = async (): Promise<void> => {
      if (persistenceDisabled) return
      await this.#recordDelta(turnMessages)
    }
    const messages = this.mutableMessages

    const queryParams: QueryParams = {
      messages: turnMessages,
      systemPrompt,
      userContext: promptParts.userContext,
      systemContext: promptParts.systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext,
      fallbackModel: config.fallbackModel,
      querySource: 'sdk' as QueryParams['querySource'],
      maxTurns: config.maxTurns,
      taskBudget: config.taskBudget,
    }

    const seedMessages = new Set<Message>(turnMessages)

    for await (const event of queryEvents(queryParams)) {
      notePrintPhase('first_canonical_event')
      config.onLiveness?.()
      if (event.kind === 'assistant_retracted') continue

      for (const projected of legacyYieldsOf(event)) {
        const kind = (projected as { type?: string }).type
        const message = projected as Message & { subtype?: string }
        let shouldRecord = false
        let isBoundary = false

        switch (kind) {
          case 'stream_request_start':
            break
          case 'stream_event': {
            const raw = projected as { type: 'stream_event'; event?: ApiStreamEvent }
            const streamEvent = raw.event
            if (streamEvent?.type === 'message_start') {
              currentUsage = updateUsage(EMPTY_USAGE, streamEvent.message.usage)
              currentStreamMessageId = streamEvent.message.id ?? null
            } else if (streamEvent?.type === 'message_delta') {
              currentUsage = updateUsage(currentUsage, streamEvent.usage)
              const deltaStop = streamEvent.delta.stop_reason
              if (deltaStop != null) capturedStopReason = deltaStop
            } else if (streamEvent?.type === 'message_stop') {
              this.#accumulatedUsage = accumulateUsage(this.#accumulatedUsage, currentUsage)
              if (currentStreamMessageId) this.#streamFoldedIds.add(currentStreamMessageId)
            }
            if (config.includePartialMessages) {
              yield asSdk({
                type: 'stream_event',
                event: streamEvent ?? raw,
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: randomUUID(),
              })
            }
            break
          }
          case 'assistant': {
            const assistant = projected as AssistantMessage
            const stopReason = assistant.message.stop_reason
            if (stopReason != null && assistant.isApiErrorMessage !== true) {
              capturedStopReason = stopReason
            }
            const providerMessageId = assistant.message.id
            if (providerMessageId) {
              this.#settledUsageById.set(
                providerMessageId,
                updateUsage(EMPTY_USAGE, assistant.message.usage),
              )
            }
            shouldRecord = true
            break
          }
          case 'user':
            this.#turnCounter++
            shouldRecord = true
            break
          case 'progress': {
            this.mutableMessages.push(message)
            turnMessages.push(message)
            void recordDelta()
            yield* normalizeMessage(message)
            break
          }
          case 'attachment': {
            this.mutableMessages.push(message)
            turnMessages.push(message)
            const attachment = (projected as { attachment?: { type?: string } }).attachment
            const attachmentType = attachment?.type
            if (attachmentType === 'dead_thinking' || attachmentType === 'bound_prefix') {
              await recordDelta()
              if (!persistenceDisabled) await flushSessionStorage()
            } else {
              void recordDelta()
            }
            if (attachmentType === 'structured_output') {
              this.#structuredOutput = (attachment as { data?: unknown }).data
            } else if (attachmentType === 'max_turns_reached') {
              if (eagerFlush) await flushSessionStorage()
              yield asSdk({
                type: 'result',
                subtype: 'error_max_turns',
                is_error: true,
                num_turns:
                  (attachment as { turnCount?: number }).turnCount ?? this.#turnCounter,
                stop_reason: capturedStopReason,
                errors: [
                  `Reached the maximum number of turns (${config.maxTurns ?? ''})`.replace(' ()', ''),
                ],
                ...buildResultEnvelope(),
              })
              return
            } else if (attachmentType === 'repetition_breaker') {
              if (eagerFlush) await flushSessionStorage()
              yield asSdk({
                type: 'result',
                subtype: 'error_repetition_breaker',
                is_error: true,
                num_turns: this.#turnCounter,
                stop_reason: capturedStopReason,
                errors: [(attachment as { cause?: string }).cause ?? 'repetition breaker'],
                ...buildResultEnvelope(),
              })
              return
            } else if (attachmentType === 'cycle_handoff') {
              const cause = (attachment as { cause?: string }).cause ?? ''
              const openItems = (attachment as { openItems?: string[] }).openItems ?? []
              const report = (attachment as { report?: string }).report ?? ''
              const openClause =
                openItems.length > 0 ? ` Unfinished: ${openItems.join('; ')}.` : ''
              yield asSdk({
                type: 'result',
                subtype: 'success',
                is_error: false,
                num_turns: turnMessages.length - 1,
                result: `HANDOFF: ${cause}${openClause}\n${report}`,
                stop_reason: capturedStopReason,
                ...buildResultEnvelope(),
              })
              return
            } else if (attachmentType === 'queued_command' && config.replayUserMessages) {
              yield asSdk({
                type: 'user',
                message: {
                  role: 'user',
                  content: (attachment as { prompt?: string }).prompt ?? '',
                },
                parent_tool_use_id: null,
                session_id: getSessionId(),
                uuid:
                  (attachment as { source_uuid?: string }).source_uuid ??
                  (projected as { uuid?: string }).uuid,
                isReplay: true,
              })
            }
            break
          }
          case 'system': {
            const systemMessage = message
            if (config.snipBoundaryCallback) {
              const snipOutcome = config.snipBoundaryCallback(systemMessage, this.mutableMessages)
              if (snipOutcome !== undefined) {
                if (snipOutcome.executed) {
                  this.mutableMessages.length = 0
                  this.mutableMessages.push(...snipOutcome.messages)
                }
                break
              }
            }
            if (systemMessage.subtype === 'api_error') {
              this.mutableMessages.push(systemMessage)
              turnMessages.push(systemMessage)
              await recordDelta()
              const apiError = systemMessage as {
                retryAttempt?: number
                maxRetries?: number
                retryInMs?: number
                errorDetail?: { status?: number | null }
                error?: { status?: number | null }
                uuid?: string
              }
              yield asSdk({
                type: 'system',
                subtype: 'api_retry',
                attempt: apiError.retryAttempt,
                max_retries: apiError.maxRetries,
                retry_delay_ms: apiError.retryInMs,
                error_status:
                  apiError.errorDetail?.status ?? apiError.error?.status ?? null,
                error: categorizeRetryableAPIError(apiError.error),
                session_id: getSessionId(),
                uuid: apiError.uuid ?? randomUUID(),
              })
              break
            }
            if (systemMessage.subtype !== 'compact_boundary') {
              const level = (systemMessage as { level?: string }).level
              if (
                systemMessage.subtype === 'informational' &&
                (level === 'warning' || level === 'error')
              ) {
                this.mutableMessages.push(systemMessage)
                turnMessages.push(systemMessage)
                await recordDelta()
                break
              }
              this.mutableMessages.push(systemMessage)
              if (
                (systemMessage as { level?: string }).level === 'warning' ||
                (systemMessage as { level?: string }).level === 'error' ||
                systemMessage.subtype === 'thinking_note'
              ) {
                turnMessages.push(systemMessage)
                await recordDelta()
              }
              break
            }
            shouldRecord = true
            isBoundary = true
            break
          }
          case 'tool_use_summary': {
            const summary = projected as {
              summary?: string
              precedingToolUseIds?: string[]
              uuid?: string
            }
            yield asSdk({
              type: 'tool_use_summary',
              summary: summary.summary,
              preceding_tool_use_ids: summary.precedingToolUseIds ?? [],
              session_id: getSessionId(),
              uuid: summary.uuid ?? randomUUID(),
            })
            break
          }
          default:
            break
        }

        if (shouldRecord) {
          if (isBoundary && !persistenceDisabled) {
            const boundaryMeta = (message as { compactMetadata?: { preservedSegment?: { tailUuid?: string } } }).compactMetadata
            const tailUuid = boundaryMeta?.preservedSegment?.tailUuid
            const tailIdx = tailUuid
              ? this.mutableMessages.findIndex(
                  candidate => (candidate as { uuid?: string }).uuid === tailUuid,
                )
              : -1
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1)).catch(
                (error: unknown) => logError(error),
              )
            }
          }
          messages.push(message)
          turnMessages.push(message)
          if (message.type === 'assistant') {
            void recordDelta()
          } else {
            await recordDelta()
          }
        }
        if (kind === 'assistant') {
          if (!firstRecordingDone) {
            firstRecordingDone = true
            if (!acknowledgedReplays) {
              acknowledgedReplays = true
              for (const replay of pendingReplays) {
                if (replay.type !== 'user') continue
                yield asSdk({
                  type: 'user',
                  message: (replay as UserMessage).message,
                  parent_tool_use_id: null,
                  session_id: getSessionId(),
                  uuid: (replay as { uuid?: string }).uuid,
                  isReplay: true,
                })
              }
            }
          }
          yield* normalizeMessage(message)
        } else if (kind === 'user') {
          yield* normalizeMessage(message)
        } else if (isBoundary) {
          const boundaryMeta = 'compactMetadata' in message ? message.compactMetadata : undefined
          const boundaryIndexStore = this.mutableMessages.length - 1
          this.mutableMessages.splice(0, boundaryIndexStore)
          const boundaryIndexTurn = turnMessages.length - 1
          turnMessages.splice(0, boundaryIndexTurn)
          this.#recordCursor = Math.max(0, this.#recordCursor - boundaryIndexTurn)
          yield asSdk({
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: boundaryMeta ? toSDKCompactMetadata(boundaryMeta) : undefined,
            session_id: getSessionId(),
            uuid: (message as { uuid?: string }).uuid,
          })
        }

        if (
          config.maxBudgetUsd !== undefined &&
          getTotalCostUSD() >= config.maxBudgetUsd
        ) {
          if (eagerFlush) await flushSessionStorage()
          yield asSdk({
            type: 'result',
            subtype: 'error_max_budget_usd',
            is_error: true,
            num_turns: this.#turnCounter,
            stop_reason: capturedStopReason,
            errors: [`Reached the maximum budget ($${config.maxBudgetUsd})`],
            ...buildResultEnvelope(),
          })
          return
        }
        if (kind === 'user' && config.jsonSchema) {
          const retries =
            this.#countSyntheticOutputCalls() - syntheticCallsBeforeTurn
          const maxRetries = Number.parseInt(
            flagEnv('MERCURY_STRUCTURED_OUTPUT_RETRIES') ??
              String(DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES),
            10,
          )
          if (retries >= maxRetries) {
            if (eagerFlush) await flushSessionStorage()
            yield asSdk({
              type: 'result',
              subtype: 'error_max_structured_output_retries',
              is_error: true,
              num_turns: this.#turnCounter,
              stop_reason: capturedStopReason,
              errors: [`Structured output failed after ${retries} attempts`],
              ...buildResultEnvelope(),
            })
            return
          }
        }
      }
    }

    let terminalMessage: (typeof turnMessages)[number] | undefined
    for (let i = turnMessages.length - 1; i >= 0; i--) {
      const message = turnMessages[i]!
      if (
        (message.type === 'assistant' || message.type === 'user') &&
        !seedMessages.has(message)
      ) {
        terminalMessage = message
        break
      }
    }
    notePrintPhase('terminal')

    const terminalType = terminalMessage?.type ?? 'undefined'
    let lastBlockType = 'n/a'
    if (terminalMessage?.type === 'assistant') {
      const content = terminalMessage.message.content
      lastBlockType = Array.isArray(content) ? (content.at(-1)?.type ?? 'none') : 'none'
    }

    if (eagerFlush) await flushSessionStorage()

    const endTurnCarveOut = !terminalMessage && capturedStopReason === 'end_turn'
    if ((!terminalMessage || !isResultSuccessful(terminalMessage)) && !endTurnCarveOut) {
      const allErrors = getInMemoryErrors()
      const watermarkIndex = errorWatermark ? allErrors.indexOf(errorWatermark) : -1
      const turnErrors = allErrors.slice(watermarkIndex + 1).map(entry => entry.error)
      yield asSdk({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: this.#turnCounter,
        stop_reason: capturedStopReason,
        errors: [
          `[ede_diagnostic] result_type=${terminalType} last_content_type=${lastBlockType} stop_reason=${capturedStopReason ?? 'null'}`,
          ...turnErrors,
        ],
        ...buildResultEnvelope(),
      })
      return
    }

    let textResult = ''
    let isApiError = false
    if (terminalMessage?.type === 'assistant') {
      const assistant = terminalMessage as AssistantMessage & {
        isApiErrorMessage?: boolean
      }
      isApiError = assistant.isApiErrorMessage === true
      const content = assistant.message.content
      if (Array.isArray(content)) {
        for (let index = content.length - 1; index >= 0; index--) {
          const block = content[index] as { type?: string; text?: string }
          if (block.type === 'text' && typeof block.text === 'string') {
            textResult = block.text
            break
          }
        }
      } else if (typeof content === 'string') {
        textResult = content
      }
    }

    if (isApiError) {
      yield asSdk({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: this.#turnCounter,
        stop_reason: capturedStopReason,
        errors: [textResult],
        ...buildResultEnvelope(),
      })
      return
    }

    yield asSdk({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: this.#turnCounter,
      result: textResult,
      stop_reason: capturedStopReason,
      ...(this.#structuredOutput !== undefined
        ? { structured_output: this.#structuredOutput }
        : {}),
      ...buildResultEnvelope(),
    })
  }

  #countSyntheticOutputCalls(): number {
    let count = 0
    for (const message of this.mutableMessages) {
      if (message.type !== 'assistant') continue
      const content = (message as AssistantMessage).message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const typed = block as { type?: string; name?: string }
        if (typed.type === 'tool_use' && typed.name === SYNTHETIC_OUTPUT_TOOL_NAME) {
          count++
        }
      }
    }
    return count
  }
}


type AskOptions = Omit<QueryEngineConfig, 'readFileState' | 'initialMessages'> & {
  prompt: string | ContentBlockParam[]
  promptUuid?: string
  isMeta?: boolean
  batchUuids?: string[]
  promptMode?: 'prompt' | 'bash'
  mutableMessages?: Message[]
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
} & { snipBoundaryCallback?: never }

export async function* ask(
  options: AskOptions,
): AsyncGenerator<SDKMessage, void, unknown> {
  const {
    prompt,
    promptUuid,
    isMeta,
    batchUuids,
    promptMode,
    mutableMessages = [],
    getReadFileCache,
    setReadFileCache,
    ...engineConfig
  } = options
  const engine = new QueryEngine({
    ...engineConfig,
    initialMessages: mutableMessages,
    readFileState: cloneFileStateCache(getReadFileCache()),
  })
  const seedLength = mutableMessages.length
  try {
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
      ...(promptMode !== undefined ? { mode: promptMode } : {}),
      ...(batchUuids !== undefined ? { batchUuids } : {}),
    })
  } finally {
    setReadFileCache(engine.getReadFileState())
    const settled = engine.getMessages()
    const seedIntact =
      seedLength === 0 ||
      (settled.length >= seedLength && settled[seedLength - 1] === mutableMessages[seedLength - 1])
    if (seedIntact) {
      if (settled.length > seedLength) mutableMessages.push(...settled.slice(seedLength))
    } else {
      mutableMessages.length = 0
      mutableMessages.push(...settled)
    }
  }
}
