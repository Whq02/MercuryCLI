import { randomUUID } from 'node:crypto'
import { getSessionId, isSessionPersistenceDisabled } from '../bootstrap/state.js'
import type { Command } from '../commands.js'
import { LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from '../constants/xml.js'
import { armWorkerParentWatch } from '../daemon/workerParentWatch.js'
import { MERCURY_IDENTITY_FLOOR } from '../prompt/mercuryContract.js'
import { queryEvents } from '../query.js'
import type { Terminal } from '../query/transitions.js'
import type { RunEvent } from '../run-core/events.js'
import { legacyYieldsOf } from '../run-core/project-legacy.js'
import type { QueryParams } from '../run-core/turn-machine.js'
import { categorizeRetryableAPIError } from '../services/api/errors.js'
import { EMPTY_USAGE, type NonNullableUsage } from '../services/api/emptyUsage.js'
import { accumulateUsage, updateUsage } from '../services/providers/anthropic/cacheAndUsage.js'
import type { Tools, ToolUseContext } from '../Tool.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/constants.js'
import type { AssistantMessage, CompactMetadata, Message, MessageOrigin, ProgressMessage } from '../types/message.js'
import type { ApiStreamEvent, ContentBlockParam } from '../types/wire.js'
import type { BatchedPrompt, QueuedCommand } from '../types/textInputTypes.js'
import type { EvalToolProgress, MCPProgress, ShellProgress } from '../types/tools.js'
import { createAttachmentMessage } from '../utils/attachments/orchestrator.js'
import { getQueuedCommandAttachments } from '../utils/attachments/queuedCommands.js'
import { getGlobalConfig } from '../utils/config.js'
import { isBareMode, isEnvTruthy } from '../utils/envUtils.js'
import type { FileStateCache } from '../utils/fileStateCache.js'
import { cloneFileStateCache } from '../utils/fileStateCache.js'
import { reconstructContentReplacementState, type ContentReplacementState } from '../utils/toolResultStorage.js'
import { fileHistoryEnabled, fileHistoryMakeSnapshot } from '../utils/fileHistory.js'
import { headlessProfilerCheckpoint } from '../utils/headlessProfiler.js'
import { engageCommitGate } from '../utils/hooks/commitGate.js'
import { registerForcedReadHook } from '../utils/hooks/forcedReadHook.js'
import { registerStructuredOutputEnforcement } from '../utils/hooks/hookHelpers.js'
import { registerRunStopHook } from '../utils/hooks/runStopHook.js'
import { lastAssistantText } from '../utils/hooks/runStopAdapter.js'
import { registerWardsHook } from '../utils/hooks/wardsHook.js'
import { parseBlockerDeclaration } from '../services/run/blockerDeclaration.js'
import { getInMemoryErrors, logError } from '../utils/log.js'
import { normalizeMessages } from '../utils/messages.js'
import { isNotEmptyMessage } from '../utils/messages/text.js'
import { NO_CONTENT_MESSAGE } from '../constants/messages.js'
import { turnCutOf } from '../utils/messages/turnCut.js'
import { getEngineModel } from '../utils/model/model.js'
import { getModelUsage, getTotalAPIDuration, getTotalCostUSD, getUnpricedTurns } from '../bootstrap/state.js'
import type { ModelUsage } from '../bootstrap/state.js'
import { noteRunPhase } from '../utils/runPhases.js'
import { processUserInput } from '../utils/processUserInput/processUserInput.js'
import { getSlashCommandToolSkills } from '../commands.js'
import { ensureExtensionsLoaded } from '../extensions/boot.js'
import { fetchSystemPromptParts } from '../utils/queryContext.js'
import { assertSingleRole } from '../utils/workerRole.js'
import { flushSessionStorage, recordTranscript } from '../utils/sessionStorage.js'
import { isEphemeralToolProgress } from '../utils/sessionStorage/paths.js'
import { setCwd } from '../utils/Shell.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import { shouldEnableThinkingByDefault } from '../utils/thinking.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { loadMemoryPrompt } from '../mneme/mnemeFrontPage.js'
import { hasMnemeHomeOverride } from '../mneme/paths.js'
import { getCwd } from '../utils/cwd.js'
import {
  commandOutputRow,
  commandOutputTextOf,
  shellOutputTextOf,
  compactionEndedRow,
  itemRowsOf,
  modelUsageRows,
  noticeRow,
  outcomeRow,
  partialRowsOf,
  retractedRow,
  retryWaitRow,
  stepRow,
  toolResultRowsOf,
  toolUpdateRow,
  turnStartedRow,
  type OutcomeFacts,
  type RowDraft,
  type RowScope,
  type SessionFacts,
} from './project.js'
import { errorClassOf, hookEndingSentence, statusOfTerminal, toolCallsRefusedSentence, HOOK_FAILED_CODE, OUTCOME_SENTENCES, TERMINAL_FAILURE_SENTENCES, type Denial, type ErrorClass, type OutcomeStatus } from './vocabulary.js'
import { childRowsOf } from './child.js'

const DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES = 5

type CanUseTool = ToolUseContext extends never ? never : QueryParams['canUseTool']
type GetAppState = ToolUseContext['getAppState']
type SetAppState = ToolUseContext['setAppState']
type McpClients = ToolUseContext['options']['mcpClients']
type AgentDefinitions = ToolUseContext['options']['agentDefinitions']['activeAgents']

export type ConversationConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: McpClients
  agents: AgentDefinitions
  canUseTool: CanUseTool
  hostHoldsAsks?: boolean
  getAppState: GetAppState
  setAppState: SetAppState
  readFileState: FileStateCache
  contentReplacementState?: ContentReplacementState
  initialMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  jsonSchema?: Record<string, unknown>
  handleElicitation?: ToolUseContext['handleElicitation']
  partialRows?: boolean
  onLiveness?: () => void
  onToolRoundSettled?: (messages: readonly Message[]) => void
  setSDKStatus?: ToolUseContext['setSDKStatus']
  abortController?: AbortController
}

export type TurnOptions = {
  uuid?: string
  isMeta?: boolean
  mode?: 'prompt' | 'bash'
  batchUuids?: string[]
  batchTail?: BatchedPrompt[]
  initialNotices?: QueuedCommand[]
  origin?: MessageOrigin
  skipSlashCommands?: boolean
  syntaxInput?: string
  turn?: number
}

function messageTextContent(message: Message): string | null {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  return null
}

function isLocalCommandOutputText(text: string): boolean {
  return text.includes(LOCAL_COMMAND_STDOUT_TAG) || text.includes(LOCAL_COMMAND_STDERR_TAG)
}


const LEDGER_COUNTERS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'costUSD'] as const

function usageSince(current: Record<string, ModelUsage>, baseline: Record<string, ModelUsage>): Record<string, ModelUsage> {
  const result: Record<string, ModelUsage> = {}
  for (const [model, row] of Object.entries(current)) {
    const delta = { ...row }
    for (const counter of LEDGER_COUNTERS) {
      delta[counter] = Math.max(0, row[counter] - (baseline[model]?.[counter] ?? 0))
    }
    if (LEDGER_COUNTERS.some(counter => delta[counter] > 0)) result[model] = delta
  }
  return result
}

const TOOL_UPDATE_BEAT_MS = 250
const TOOL_UPDATE_MAP_CAP = 100
const TOOL_UPDATE_LINE_MAX = 300
const toolUpdateState = new Map<string, { lastEmitMs: number; tick: number }>()

function latestLineOf(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line === '') continue
    return line.length > TOOL_UPDATE_LINE_MAX ? `${line.slice(0, TOOL_UPDATE_LINE_MAX)}…` : line
  }
  return undefined
}

function lastTextBlockOf(message: AssistantMessage): string {
  const content = message.message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (let index = content.length - 1; index >= 0; index--) {
    const block = content[index] as { type?: string; text?: string }
    if (block.type === 'text' && typeof block.text === 'string') return block.text === NO_CONTENT_MESSAGE ? '' : block.text
  }
  return ''
}

export async function sessionFactsOf(config: Pick<ConversationConfig, 'cwd' | 'tools' | 'mcpClients' | 'commands' | 'agents'>, model: string, mode: string): Promise<SessionFacts> {
  headlessProfilerCheckpoint('before_skills_extensions')
  const [skills, loaded] = await Promise.all([getSlashCommandToolSkills(config.cwd), ensureExtensionsLoaded({ cwd: config.cwd })])
  headlessProfilerCheckpoint('after_skills_extensions')
  const invocable = (entry: { userInvocable?: boolean }): boolean => entry.userInvocable !== false
  return {
    version: MACRO.VERSION,
    cwd: getCwd(),
    model,
    mode,
    tools: config.tools.map(tool => tool.name),
    mcpServers: config.mcpClients.map(client => ({ name: client.name, status: client.type })),
    commands: config.commands.filter(invocable).map(command => command.name),
    agents: (config.agents ?? []).map(agent => agent.agentType),
    skills: skills.filter(invocable).map(skill => skill.name),
    extensions: loaded.set.active.map(ext => ({ name: ext.manifest.name, path: ext.root, id: ext.entry.id })),
  }
}

class StepLedger {
  private open: { messageId: string; model: string; stop: string | null; usage: NonNullableUsage } | null = null
  private readonly done = new Set<string>()
  readonly blocks = new Map<string, number>()
  count = 0
  lastModel = ''
  constructor(private readonly scope: RowScope) {}

  see(messageId: string, model: string, usage: NonNullableUsage, stop: string | null): RowDraft | null {
    let flushed: RowDraft | null = null
    if (this.open !== null && this.open.messageId !== messageId) flushed = this.flush()
    if (this.done.has(messageId)) return flushed
    this.open = { messageId, model, usage, stop: stop ?? this.open?.stop ?? null }
    return flushed
  }

  flush(): RowDraft | null {
    if (this.open === null) return null
    const { messageId, model, usage, stop } = this.open
    this.open = null
    this.done.add(messageId)
    this.count += 1
    return stepRow(this.scope, { messageId, model, stopReason: stop, usage })
  }

  settle(messageId: string, usage: NonNullableUsage, stop: string | null): RowDraft | null {
    if (this.open !== null && this.open.messageId === messageId) {
      this.open.usage = usage
      if (stop !== null) this.open.stop = stop
      return this.flush()
    }
    if (this.done.has(messageId)) return null
    this.open = { messageId, model: this.lastModel, usage, stop }
    return this.flush()
  }
}

export class Conversation {
  private readonly config: ConversationConfig
  private readonly mutableMessages: Message[]
  private readonly readFileState: FileStateCache
  private readonly contentReplacementState: ContentReplacementState
  private readonly abortController: AbortController
  private userSpecifiedModel: string | undefined
  private readonly loadedNestedMemoryPaths = new Set<string>()
  private readonly discoveredSkillNames = new Set<string>()
  private readonly denials: Denial[] = []
  private accumulatedUsage: NonNullableUsage = { ...EMPTY_USAGE }
  private readonly streamFoldedIds = new Set<string>()
  private readonly settledUsageById = new Map<string, NonNullableUsage>()
  private turnOrdinal = 0
  private recordCursor = 0
  private recordChain: Promise<string | null> = Promise.resolve(null)
  private structuredOutput: unknown

  constructor(config: ConversationConfig) {
    this.config = config
    this.mutableMessages = [...(config.initialMessages ?? [])]
    this.readFileState = config.readFileState
    this.contentReplacementState = config.contentReplacementState ?? {
      ...reconstructContentReplacementState(this.mutableMessages, []),
      budgetChars: Infinity,
    }
    this.abortController = config.abortController ?? new AbortController()
    this.userSpecifiedModel = config.userSpecifiedModel
  }

  interrupt(): void {
    this.abortController.abort()
  }

  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  getReadFileState(): FileStateCache {
    return this.readFileState
  }

  getSessionId(): string {
    return getSessionId()
  }

  setModel(model: string): void {
    this.userSpecifiedModel = model
  }

  private recordDelta(turnMessages: Message[]): Promise<string | null> {
    const pending = turnMessages.slice(this.recordCursor)
    this.recordCursor = turnMessages.length
    if (pending.length === 0) return this.recordChain
    this.recordChain = this.recordChain.then(hint =>
      recordTranscript(pending, (hint ?? undefined) as Parameters<typeof recordTranscript>[1], turnMessages).catch((error: unknown) => {
        logError(error)
        return null
      }),
    )
    return this.recordChain
  }

  private countSyntheticOutputCalls(): number {
    let count = 0
    for (const message of this.mutableMessages) {
      if (message.type !== 'assistant') continue
      const content = (message as AssistantMessage).message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const typed = block as { type?: string; name?: string }
        if (typed.type === 'tool_use' && typed.name === SYNTHETIC_OUTPUT_TOOL_NAME) count++
      }
    }
    return count
  }

  async *turn(prompt: string | ContentBlockParam[], options?: TurnOptions): AsyncGenerator<RowDraft, void, unknown> {
    const config = this.config
    this.discoveredSkillNames.clear()
    setCwd(config.cwd)
    const persistenceDisabled = isSessionPersistenceDisabled()
    const turnStartedAt = Date.now()
    const apiDurationAtStart = getTotalAPIDuration()
    const costAtStart = getTotalCostUSD()
    const modelUsageAtStart = Object.fromEntries(Object.entries(getModelUsage()).map(([model, row]) => [model, { ...row }]))
    const unpricedAtStart = { ...getUnpricedTurns() }
    const eagerFlush = isEnvTruthy(process.env.MERCURY_EAGER_FLUSH)
    const errorWatermark = getInMemoryErrors().at(-1)
    this.turnOrdinal += 1
    const turnOrdinal = options?.turn ?? this.turnOrdinal
    const turnId = randomUUID()
    const promptUuid = options?.uuid ?? randomUUID()
    const scope: RowScope = { session_id: getSessionId(), turn: turnOrdinal }
    const scopeFor = (parentCallId: string | undefined): RowScope => (parentCallId === undefined ? scope : { ...scope, parent_call_id: parentCallId })
    const notices: Array<{ level: 'warning' | 'error'; text: string }> = []
    const steps = new StepLedger(scope)
    const toolOutcomes = new Map<string, 'ok' | 'error' | 'aborted'>()
    const callScopes = new Map<string, RowScope>()
    const denialsBefore = this.denials.length

    const wrappedCanUseTool: CanUseTool = (async (
      tool: { name: string },
      input: Record<string, unknown>,
      toolUseContext: ToolUseContext,
      assistantMessage: AssistantMessage,
      toolUseID: string,
      forceDecision?: unknown,
    ) => {
      const decision = await (config.canUseTool as (...args: unknown[]) => Promise<{ behavior?: string }>)(tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision)
      if (decision?.behavior !== 'allow') this.denials.push({ tool: tool.name, call_id: toolUseID, input })
      return decision
    }) as CanUseTool

    const appStateSnapshot = config.getAppState()
    const resolvedModel = this.userSpecifiedModel ?? getEngineModel()
    const thinkingConfig: ThinkingConfig =
      config.thinkingConfig ?? (shouldEnableThinkingByDefault() ? ({ type: 'adaptive' } as ThinkingConfig) : ({ type: 'disabled' } as ThinkingConfig))

    headlessProfilerCheckpoint('before_getSystemPrompt')
    const promptParts = await fetchSystemPromptParts({
      tools: config.tools,
      engineModel: resolvedModel,
      mcpClients: config.mcpClients,
      customSystemPrompt: config.customSystemPrompt,
      permissionMode: appStateSnapshot.toolPermissionContext.mode,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')

    let memoryMechanicsPrompt: string | null = null
    if (config.customSystemPrompt !== undefined && hasMnemeHomeOverride()) memoryMechanicsPrompt = await loadMemoryPrompt()

    const systemPromptSections: string[] = config.customSystemPrompt !== undefined ? [MERCURY_IDENTITY_FLOOR, config.customSystemPrompt] : [...promptParts.defaultSystemPrompt]
    if (memoryMechanicsPrompt) systemPromptSections.push(memoryMechanicsPrompt)
    if (config.appendSystemPrompt) systemPromptSections.push(config.appendSystemPrompt)
    const systemPrompt = asSystemPrompt(systemPromptSections)

    const sessionId = getSessionId()
    const hasSyntheticOutputTool = config.tools.some(tool => tool.name === SYNTHETIC_OUTPUT_TOOL_NAME)
    if (config.jsonSchema && hasSyntheticOutputTool) registerStructuredOutputEnforcement(config.setAppState, sessionId)
    const forcedReadList = (flagEnv('MERCURY_FORCE_READ_FILES') ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)
    if (forcedReadList.length > 0) registerForcedReadHook(config.setAppState, sessionId, forcedReadList)
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
        engineModel: model,
        thinkingConfig,
        tools: config.tools,
        mcpClients: config.mcpClients,
        mcpResources: {},
        isNonInteractiveSession: true,
        ...(config.hostHoldsAsks === true ? { hostHoldsAsks: true } : {}),
        customSystemPrompt: config.customSystemPrompt,
        appendSystemPrompt: config.appendSystemPrompt,
        agentDefinitions: { activeAgents: config.agents ?? [], allAgents: [] },
        theme: getGlobalConfig().theme,
        maxBudgetUsd: config.maxBudgetUsd,
        querySource: 'sdk',
      },
      abortController: this.abortController,
      readFileState: this.readFileState,
      contentReplacementState: this.contentReplacementState,
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
      discoveredSkillNames: this.discoveredSkillNames,
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      dynamicSkillDirTriggers: new Set<string>(),
    })
    if (options?.initialNotices?.length) {
      const attachments = await getQueuedCommandAttachments(options.initialNotices)
      this.mutableMessages.push(...attachments.map(createAttachmentMessage))
      if (!persistenceDisabled) await this.recordDelta(this.mutableMessages)
    }
    let toolUseContext = buildContext(this.mutableMessages, resolvedModel)

    const messageIds = [promptUuid, ...(options?.batchUuids ?? []).filter(uuid => uuid !== promptUuid)]
    yield turnStartedRow(scope, { turnId, messageIds, model: resolvedModel })

    const rowsOfMessage = (message: Message, parentCallId: string | undefined): RowDraft[] => {
      const rows: RowDraft[] = []
      const rowScope = scopeFor(parentCallId)
      if (parentCallId !== undefined && (message.type === 'assistant' || message.type === 'user')) {
        const child = childRowsOf({ ...scope, parent_call_id: parentCallId }, message)
        for (const row of child) {
          const call = row as RowDraft & { call_id?: string }
          if (call.type === 'tool_call' && call.call_id !== undefined) callScopes.set(call.call_id, rowScope)
        }
        return child
      }
      if (message.type === 'assistant') {
        const assistant = message as AssistantMessage & { isApiErrorMessage?: boolean }
        if (assistant.isApiErrorMessage === true || !isNotEmptyMessage(message)) return rows
        const messageId = assistant.message.id ?? (assistant.uuid as string)
        const content = assistant.message.content
        const base = steps.blocks.get(messageId) ?? 0
        const length = Array.isArray(content) ? content.length : 1
        steps.blocks.set(messageId, base + length)
        let block = base
        for (const normalized of normalizeMessages([message])) {
          const pieces = (normalized as AssistantMessage).message.content
          const items = itemRowsOf(rowScope, messageId, pieces, block)
          for (const item of items) if (item.type === 'tool_call') callScopes.set(item.call_id, rowScope)
          rows.push(...items)
          block += Array.isArray(pieces) ? pieces.length : 1
        }
        return rows
      }
      if (message.type === 'user') {
        rows.push(...toolResultRowsOf(rowScope, (message as { message: { content: unknown } }).message.content, (callId, isError) => toolOutcomes.get(callId) ?? (isError ? 'error' : 'ok')))
        return rows
      }
      if (message.type === 'progress') {
        const progress = message as ProgressMessage
        const data = progress.data as { type?: string; message?: Message; elapsedTimeSeconds?: number }
        if (data.type === 'agent_progress' || data.type === 'skill_progress') {
          const inner = data.message as Message
          return rowsOfMessage(inner, progress.parentToolUseID)
        }
        const evalRunning = data.type === 'eval_progress' && (data as { kind?: string }).kind === 'running' ? (data as Extract<EvalToolProgress, { kind: 'running' }>) : null
        if (isEphemeralToolProgress(data.type) || evalRunning !== null) {
          const callId = callScopes.has(progress.toolUseID) ? progress.toolUseID : progress.parentToolUseID
          const updateScope = callScopes.get(callId) ?? rowScope
          const key = JSON.stringify([scope.session_id, callId])
          const now = Date.now()
          const state = toolUpdateState.get(key)
          if (state !== undefined && now - state.lastEmitMs < TOOL_UPDATE_BEAT_MS) return rows
          while (toolUpdateState.size >= TOOL_UPDATE_MAP_CAP) {
            const oldest = toolUpdateState.keys().next()
            if (oldest.done) break
            toolUpdateState.delete(oldest.value)
          }
          const tick = (state?.tick ?? 0) + 1
          toolUpdateState.set(key, { lastEmitMs: now, tick })
          if (evalRunning !== null) {
            rows.push(
              toolUpdateRow(updateScope, {
                callId,
                tick,
                source: 'eval',
                line: latestLineOf(evalRunning.tail),
                elapsedS: evalRunning.elapsedSeconds,
                budgetMs: evalRunning.budgetMs,
              }),
            )
            return rows
          }
          const shell = data as Partial<ShellProgress>
          const mcp = data as Partial<MCPProgress>
          const isMcp = data.type === 'mcp_progress'
          rows.push(
            toolUpdateRow(updateScope, {
              callId,
              tick,
              source: isMcp ? 'mcp' : data.type === 'powershell_progress' ? 'powershell' : 'shell',
              line: isMcp ? latestLineOf(mcp.progressMessage) : latestLineOf(shell.output),
              elapsedS: typeof data.elapsedTimeSeconds === 'number' ? data.elapsedTimeSeconds : undefined,
              lines: !isMcp && typeof shell.totalLines === 'number' ? shell.totalLines : undefined,
              bytes: !isMcp && typeof shell.totalBytes === 'number' ? shell.totalBytes : undefined,
              budgetMs: !isMcp && typeof shell.budgetMs === 'number' ? shell.budgetMs : undefined,
              progress: isMcp && typeof mcp.progress === 'number' ? mcp.progress : undefined,
              total: isMcp && typeof mcp.total === 'number' ? mcp.total : undefined,
            }),
          )
        }
        return rows
      }
      return rows
    }

    const syntheticCallsBeforeTurn = this.countSyntheticOutputCalls()
    const priorUuids = new Set<string>(this.mutableMessages.map(message => message.uuid))

    const inputResult = await processUserInput({
      input: prompt,
      syntaxInput: options?.syntaxInput,
      mode: options?.mode ?? 'prompt',
      setToolJSX: () => {},
      context: toolUseContext as Parameters<typeof processUserInput>[0]['context'],
      messages: this.mutableMessages,
      uuid: promptUuid,
      ...(options?.batchUuids !== undefined ? { batchUuids: options.batchUuids } : {}),
      ...(options?.batchTail !== undefined ? { batchTail: options.batchTail } : {}),
      isMeta: options?.isMeta,
      ...(options?.origin !== undefined ? { origin: options.origin } : {}),
      ...(options?.skipSlashCommands === true ? { skipSlashCommands: true } : {}),
      querySource: 'sdk',
      canUseTool: wrappedCanUseTool,
    })

    this.mutableMessages.push(...inputResult.messages)
    let turnMessages: Message[] = [...this.mutableMessages]
    const seedMessages = new Set<Message>(turnMessages)

    if (!persistenceDisabled && inputResult.messages.length > 0) {
      const recordPromise = this.recordDelta(turnMessages)
      if (isBareMode()) {
        void recordPromise
      } else {
        await recordPromise
        if (eagerFlush) await flushSessionStorage()
      }
    } else {
      this.recordCursor = turnMessages.length
    }

    if (inputResult.allowedTools && inputResult.allowedTools.length > 0) {
      config.setAppState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          alwaysAllowRules: {
            ...prev.toolPermissionContext.alwaysAllowRules,
            command: [...new Set([...(prev.toolPermissionContext.alwaysAllowRules.command ?? []), ...inputResult.allowedTools!])],
          },
        },
      }))
    }

    const effectiveModel = inputResult.model ?? resolvedModel
    steps.lastModel = effectiveModel
    toolUseContext = buildContext(turnMessages, effectiveModel)

    let capturedStopReason: string | null = null

    const outcomeFactsOf = (status: OutcomeStatus, extra: Partial<OutcomeFacts> = {}): OutcomeFacts => {
      for (const [messageId, usage] of this.settledUsageById) {
        if (this.streamFoldedIds.has(messageId)) continue
        this.streamFoldedIds.add(messageId)
        if (usage.input_tokens === 0 && usage.output_tokens === 0) continue
        this.accumulatedUsage = accumulateUsage(this.accumulatedUsage, usage)
      }
      noteRunPhase('settlement')
      const unpricedNow = getUnpricedTurns()
      const unpricedModels = new Set(Object.keys(unpricedNow).filter(model => (unpricedNow[model] ?? 0) > (unpricedAtStart[model] ?? 0)))
      const apiMs = Math.max(0, getTotalAPIDuration() - apiDurationAtStart)
      const billed = usageSince(getModelUsage(), modelUsageAtStart)
      const usage = Object.values(billed).reduce((sum, row) => ({
        ...sum,
        input_tokens: sum.input_tokens + row.inputTokens,
        output_tokens: sum.output_tokens + row.outputTokens,
        cache_read_input_tokens: sum.cache_read_input_tokens + row.cacheReadInputTokens,
        cache_creation_input_tokens: sum.cache_creation_input_tokens + row.cacheCreationInputTokens,
      }), { ...EMPTY_USAGE, output_tokens_details: this.accumulatedUsage.output_tokens_details })
      return {
        turnId,
        status,
        stopReason: capturedStopReason,
        steps: steps.count,
        wallMs: Date.now() - turnStartedAt,
        ...(apiMs > 0 ? { apiMs } : {}),
        ...(unpricedModels.size === 0 ? { costUsd: Math.max(0, getTotalCostUSD() - costAtStart) } : {}),
        usage,
        models: modelUsageRows(billed, model => unpricedModels.has(model)),
        denials: this.denials.slice(denialsBefore),
        ...(notices.length > 0 ? { notices: [...notices] } : {}),
        ...extra,
      }
    }
    const closeTurn = (status: OutcomeStatus, extra: Partial<OutcomeFacts> = {}): RowDraft => outcomeRow({ ...scope, turn: turnOrdinal }, outcomeFactsOf(status, extra))

    headlessProfilerCheckpoint('turn_row_yielded')
    noteRunPhase('assembly')

    if (!inputResult.shouldQuery) {
      let commandAnswer = ''
      for (const message of inputResult.messages) {
        if (priorUuids.has(message.uuid)) continue
        if (message.type === 'user') {
          const text = messageTextContent(message)
          const isCompactSummary = (message as { isCompactSummary?: boolean }).isCompactSummary === true
          const shellOutput = text !== null && options?.mode === 'bash' ? shellOutputTextOf(text) : null
          if (shellOutput !== null) {
            commandAnswer = shellOutput
            yield commandOutputRow(scope, shellOutput, typeof prompt === 'string' ? prompt : undefined)
          } else if (text !== null && isLocalCommandOutputText(text) && !isCompactSummary) {
            yield commandOutputRow(scope, commandOutputTextOf(text), typeof prompt === 'string' ? prompt.split(/\s+/)[0] : undefined)
          }
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'local_command') {
          const content = (message as { content?: unknown }).content
          if (typeof content === 'string' && isLocalCommandOutputText(content)) {
            yield commandOutputRow(scope, commandOutputTextOf(content), typeof prompt === 'string' ? prompt.split(/\s+/)[0] : undefined)
          }
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compactMetadata?: CompactMetadata }).compactMetadata
          yield compactionEndedRow(scope, { trigger: meta?.trigger ?? 'manual', tokensBefore: meta?.preTokens })
        }
      }
      if (!persistenceDisabled) {
        await this.recordDelta(turnMessages)
        if (eagerFlush) await flushSessionStorage()
      }
      if (options?.mode === 'bash' && this.abortController.signal.aborted) {
        const cut = turnCutOf(this.abortController.signal.reason)
        const ended = statusOfTerminal({ reason: 'aborted_tools' }, cut.kind)
        yield closeTurn(ended.status, { error: { message: ended.status === 'interrupted' ? OUTCOME_SENTENCES.interrupted({}) : cut.kind === 'idle-timeout' ? 'The turn was aborted after a no-progress timeout' : `The turn was cut: ${cut.detail ?? 'the run was aborted'}`, class: ended.errorClass ?? 'interrupt' } })
        return
      }
      if (inputResult.commandError !== undefined) {
        yield closeTurn('failed', { error: { message: inputResult.commandError, class: 'command' } })
        return
      }
      const refused = inputResult.commandRefused === true || inputResult.hookBlocked === true
      yield closeTurn(refused ? 'refused' : 'completed', {
        ...(refused
          ? { error: { message: inputResult.resultText ?? 'The request was refused', class: inputResult.hookBlocked === true ? 'hook' : 'command' } }
          : { answer: inputResult.resultText ?? commandAnswer }),
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
          snapshots.push(fileHistoryMakeSnapshot(toolUseContext.updateFileHistoryState, uuid as Parameters<typeof fileHistoryMakeSnapshot>[1]).catch((error: unknown) => logError(error)))
        }
      }
      await Promise.all(snapshots)
    }

    let currentUsage: NonNullableUsage = { ...EMPTY_USAGE }
    let currentStreamMessageId: string | null = null
    let currentStreamModel: string = effectiveModel
    let terminal: Terminal | undefined
    let apiErrorMessage: (AssistantMessage & { error?: string }) | null = null

    const recordDelta = async (): Promise<void> => {
      if (persistenceDisabled) return
      await this.recordDelta(turnMessages)
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
    }

    for await (const event of queryEvents(queryParams) as AsyncGenerator<RunEvent, unknown, unknown>) {
      noteRunPhase('first_canonical_event')
      config.onLiveness?.()
      if (event.kind === 'run_terminal') {
        terminal = event.terminal
        continue
      }
      if (event.kind === 'tool_settled') toolOutcomes.set(event.toolUseId, event.outcome)
      if (event.kind === 'assistant_retracted') {
        const withdrawn = (event.message as AssistantMessage).message.id
        if (config.partialRows && typeof withdrawn === 'string') yield retractedRow(scope, withdrawn)
        continue
      }

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
              currentStreamModel = (streamEvent.message as { model?: string }).model ?? effectiveModel
              steps.lastModel = currentStreamModel
            } else if (streamEvent?.type === 'message_delta') {
              currentUsage = updateUsage(currentUsage, streamEvent.usage)
              const deltaStop = streamEvent.delta.stop_reason
              if (deltaStop != null) capturedStopReason = deltaStop
            } else if (streamEvent?.type === 'message_stop') {
              this.accumulatedUsage = accumulateUsage(this.accumulatedUsage, currentUsage)
              if (currentStreamMessageId) {
                this.streamFoldedIds.add(currentStreamMessageId)
                const step = steps.settle(currentStreamMessageId, currentUsage, capturedStopReason)
                if (step !== null) yield step
              }
            }
            if (config.partialRows && streamEvent !== undefined) {
              for (const row of partialRowsOf(scope, currentStreamMessageId ?? '', streamEvent as Parameters<typeof partialRowsOf>[2])) yield row
            }
            break
          }
          case 'assistant': {
            const assistant = projected as AssistantMessage & { isApiErrorMessage?: boolean; error?: string }
            const stopReason = assistant.message.stop_reason
            if (stopReason != null && assistant.isApiErrorMessage !== true) capturedStopReason = stopReason
            if (assistant.isApiErrorMessage === true) apiErrorMessage = assistant
            const providerMessageId = assistant.message.id
            if (providerMessageId) {
              const usage = updateUsage(EMPTY_USAGE, assistant.message.usage)
              this.settledUsageById.set(providerMessageId, usage)
              if (assistant.isApiErrorMessage !== true) {
                const flushed = steps.see(providerMessageId, assistant.message.model ?? currentStreamModel, usage, stopReason ?? null)
                if (flushed !== null) yield flushed
              }
            }
            shouldRecord = true
            break
          }
          case 'user':
            shouldRecord = true
            break
          case 'progress': {
            this.mutableMessages.push(message)
            turnMessages.push(message)
            void recordDelta()
            for (const row of rowsOfMessage(message, undefined)) yield row
            break
          }
          case 'attachment': {
            this.mutableMessages.push(message)
            turnMessages.push(message)
            const attachment = (projected as { attachment?: { type?: string } }).attachment
            const attachmentType = attachment?.type
            if (attachmentType === 'dead_thinking' || attachmentType === 'bound_prefix' || attachmentType === 'images_left_out') {
              await recordDelta()
              if (!persistenceDisabled) await flushSessionStorage()
            } else {
              void recordDelta()
            }
            if (attachmentType === 'hook_non_blocking_error') {
              const failed = attachment as { stderr?: string; stdout?: string; hookName?: string; hookEvent?: string; exitCode?: number }
              const text = (failed.stderr || failed.stdout || '').trim() || hookEndingSentence({ status: 'failed', class: 'exit', exit_code: failed.exitCode ?? 1 }, { name: failed.hookName ?? '', event: failed.hookEvent ?? '' })
              notices.push({ level: 'warning', text })
              yield noticeRow(scope, 'warning', text, HOOK_FAILED_CODE)
            } else if (attachmentType === 'structured_output') {
              this.structuredOutput = (attachment as { data?: unknown }).data
            } else if (attachmentType === 'max_turns_reached') {
              if (eagerFlush) await flushSessionStorage()
              const open = steps.flush()
              if (open !== null) yield open
              yield closeTurn('turn_limit', { error: { message: OUTCOME_SENTENCES.turn_limit({ maxTurns: config.maxTurns }), class: 'turn_limit' } })
              return
            } else if (attachmentType === 'loop_stopped') {
              if (eagerFlush) await flushSessionStorage()
              const stopped = attachment as { message?: string; cycle?: string[] }
              const open = steps.flush()
              if (open !== null) yield open
              yield closeTurn('loop_stopped', {
                error: {
                  message: OUTCOME_SENTENCES.loop_stopped({ message: stopped.message ?? `The loop guard ended the turn: the cycle ${(stopped.cycle ?? []).join(' -> ')} repeated with identical arguments and results` }),
                  class: 'loop_stopped',
                  ...(stopped.cycle !== undefined && stopped.cycle.length > 0 ? { detail: stopped.cycle } : {}),
                },
              })
              return
            }
            break
          }
          case 'system': {
            const systemMessage = message
            if (systemMessage.subtype === 'api_error') {
              this.mutableMessages.push(systemMessage)
              turnMessages.push(systemMessage)
              await recordDelta()
              const apiError = systemMessage as { retryAttempt?: number; maxRetries?: number; retryInMs?: number; errorDetail?: { status?: number | null }; error?: { status?: number | null } }
              yield retryWaitRow(scope, {
                attempt: apiError.retryAttempt,
                of: apiError.maxRetries,
                reason: categorizeRetryableAPIError(apiError.error),
                delayMs: apiError.retryInMs,
                httpStatus: apiError.errorDetail?.status ?? apiError.error?.status ?? null,
                sinceMs: Date.now() - turnStartedAt,
              })
              break
            }
            if (systemMessage.subtype !== 'compact_boundary') {
              const level = (systemMessage as { level?: string }).level
              if (systemMessage.subtype === 'informational' && (level === 'warning' || level === 'error')) {
                this.mutableMessages.push(systemMessage)
                turnMessages.push(systemMessage)
                await recordDelta()
                const text = String((systemMessage as { content?: unknown }).content ?? '')
                notices.push({ level, text })
                yield noticeRow(scope, level, text)
                break
              }
              this.mutableMessages.push(systemMessage)
              if (level === 'warning' || level === 'error' || systemMessage.subtype === 'thinking_note' || systemMessage.subtype === 'stream_cut' || systemMessage.subtype === 'busy_recovery') {
                turnMessages.push(systemMessage)
                await recordDelta()
              }
              break
            }
            shouldRecord = true
            isBoundary = true
            break
          }
          default:
            break
        }

        if (shouldRecord) {
          if (isBoundary && !persistenceDisabled) {
            const boundaryMeta = (message as { compactMetadata?: { preservedSegment?: { tailUuid?: string } } }).compactMetadata
            const tailUuid = boundaryMeta?.preservedSegment?.tailUuid
            const tailIdx = tailUuid ? this.mutableMessages.findIndex(candidate => (candidate as { uuid?: string }).uuid === tailUuid) : -1
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1)).catch((error: unknown) => logError(error))
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
          for (const row of rowsOfMessage(message, undefined)) yield row
        } else if (kind === 'user') {
          for (const row of rowsOfMessage(message, undefined)) yield row
          config.onToolRoundSettled?.(messages)
        } else if (isBoundary) {
          const boundaryMeta = 'compactMetadata' in message ? (message.compactMetadata as CompactMetadata | undefined) : undefined
          const boundaryIndexStore = this.mutableMessages.length - 1
          this.mutableMessages.splice(0, boundaryIndexStore)
          const boundaryIndexTurn = turnMessages.length - 1
          turnMessages.splice(0, boundaryIndexTurn)
          this.recordCursor = Math.max(0, this.recordCursor - boundaryIndexTurn)
          yield compactionEndedRow(scope, { trigger: boundaryMeta?.trigger ?? (event.kind === 'compaction_boundary' ? event.trigger : 'auto'), tokensBefore: boundaryMeta?.preTokens })
        }

        if (config.maxBudgetUsd !== undefined && getTotalCostUSD() >= config.maxBudgetUsd) {
          if (eagerFlush) await flushSessionStorage()
          const open = steps.flush()
          if (open !== null) yield open
          yield closeTurn('budget_limit', { error: { message: OUTCOME_SENTENCES.budget_limit({ maxBudgetUsd: config.maxBudgetUsd }), class: 'budget_limit' } })
          return
        }
        if (kind === 'user' && config.jsonSchema) {
          const retries = this.countSyntheticOutputCalls() - syntheticCallsBeforeTurn
          const maxRetries = Number.parseInt(flagEnv('MERCURY_STRUCTURED_OUTPUT_RETRIES') ?? String(DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES), 10)
          if (retries >= maxRetries) {
            if (eagerFlush) await flushSessionStorage()
            const open = steps.flush()
            if (open !== null) yield open
            yield closeTurn('schema_unmet', { error: { message: OUTCOME_SENTENCES.schema_unmet({}), class: 'schema_unmet', detail: [`Structured output failed after ${retries} attempts`] } })
            return
          }
        }
      }
    }

    noteRunPhase('terminal')
    if (eagerFlush) await flushSessionStorage()
    const open = steps.flush()
    if (open !== null) yield open

    let answer = ''
    for (let i = turnMessages.length - 1; i >= 0; i--) {
      const message = turnMessages[i]!
      if (message.type !== 'assistant') continue
      if ((message as { isApiErrorMessage?: boolean }).isApiErrorMessage === true) continue
      answer = lastTextBlockOf(message as AssistantMessage)
      if (answer !== '') break
    }

    if (terminal === undefined) {
      yield closeTurn('failed', { error: { message: 'The turn ended without a terminal', class: 'internal' } })
      return
    }
    const aborted = terminal.reason === 'aborted_streaming' || terminal.reason === 'aborted_tools'
    const cut = aborted ? turnCutOf(this.abortController.signal.reason).kind : null
    let lastAssistant: (AssistantMessage & { isApiErrorMessage?: boolean }) | undefined
    for (let i = turnMessages.length - 1; i >= 0; i--) {
      const message = turnMessages[i]!
      if (message.type === 'assistant' && !seedMessages.has(message)) {
        lastAssistant = message as AssistantMessage & { isApiErrorMessage?: boolean }
        break
      }
    }
    const endedOnApiError = terminal.reason === 'completed' && lastAssistant?.isApiErrorMessage === true
    const settled = endedOnApiError ? { status: 'failed' as const, errorClass: 'model' as const } : statusOfTerminal(terminal, cut)
    if (settled.status === 'completed') {
      const blocker = parseBlockerDeclaration(lastAssistantText(lastAssistant === undefined ? [] : [lastAssistant]))
      if (blocker.kind === 'declared') {
        yield closeTurn('blocked', { answer, error: { message: `Blocked on the operator: ${blocker.description}`, class: 'blocked', detail: [`resume when: ${blocker.resumeCondition}`] } })
        return
      }
      yield closeTurn('completed', { answer, ...(this.structuredOutput !== undefined ? { structured: this.structuredOutput } : {}) })
      return
    }
    const allErrors = getInMemoryErrors()
    const watermarkIndex = errorWatermark ? allErrors.indexOf(errorWatermark) : -1
    const turnErrors = allErrors.slice(watermarkIndex + 1).map(entry => entry.error)
    const errorClass: ErrorClass = settled.errorClass ?? (settled.status === 'interrupted' ? 'interrupt' : 'internal')
    let message: string
    if (settled.status === 'interrupted') {
      message = OUTCOME_SENTENCES.interrupted({})
    } else if (terminal.reason === 'model_error' || endedOnApiError) {
      message = apiErrorMessage !== null ? lastTextBlockOf(apiErrorMessage) : terminal.reason === 'model_error' ? (terminal.error instanceof Error ? terminal.error.message : String(terminal.error ?? 'The model call failed')) : 'The model call failed'
    } else if (cut !== null) {
      message = cut === 'idle-timeout' ? 'The turn was aborted after a no-progress timeout' : `The turn was cut: ${turnCutOf(this.abortController.signal.reason).detail ?? 'the run was aborted'}`
    } else if (terminal.reason === 'max_turns') {
      message = OUTCOME_SENTENCES.turn_limit({ maxTurns: config.maxTurns })
    } else if (terminal.reason === 'loop_stopped') {
      message = OUTCOME_SENTENCES.loop_stopped({})
    } else if (terminal.reason === 'tool_calls_refused') {
      message = toolCallsRefusedSentence(terminal)
    } else {
      message = TERMINAL_FAILURE_SENTENCES[terminal.reason]
    }
    const finalClass: ErrorClass = (terminal.reason === 'model_error' || endedOnApiError) && apiErrorMessage?.error !== undefined ? errorClassOf(apiErrorMessage.error) : errorClass
    yield closeTurn(settled.status, {
      error: {
        message,
        class: finalClass,
        ...(turnErrors.length > 0 ? { detail: turnErrors } : {}),
      },
    })
  }
}

export type AskOptions = Omit<ConversationConfig, 'readFileState' | 'initialMessages'> & {
  prompt: string | ContentBlockParam[]
  promptUuid?: string
  isMeta?: boolean
  origin?: MessageOrigin
  skipSlashCommands?: boolean
  syntaxInput?: string
  batchUuids?: string[]
  batchTail?: BatchedPrompt[]
  initialNotices?: QueuedCommand[]
  promptMode?: 'prompt' | 'bash'
  turn?: number
  mutableMessages?: Message[]
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
}

export async function* ask(options: AskOptions): AsyncGenerator<RowDraft, void, unknown> {
  const { prompt, promptUuid, isMeta, origin, skipSlashCommands, syntaxInput, batchUuids, batchTail, initialNotices, promptMode, turn, mutableMessages = [], getReadFileCache, setReadFileCache, ...config } = options
  const conversation = new Conversation({
    ...config,
    initialMessages: mutableMessages,
    readFileState: cloneFileStateCache(getReadFileCache()),
  })
  const seedLength = mutableMessages.length
  try {
    yield* conversation.turn(prompt, {
      syntaxInput,
      uuid: promptUuid,
      isMeta,
      ...(origin !== undefined ? { origin } : {}),
      ...(skipSlashCommands === true ? { skipSlashCommands: true } : {}),
      ...(promptMode !== undefined ? { mode: promptMode } : {}),
      ...(batchUuids !== undefined ? { batchUuids } : {}),
      ...(batchTail !== undefined ? { batchTail } : {}),
      ...(initialNotices !== undefined ? { initialNotices } : {}),
      ...(turn !== undefined ? { turn } : {}),
    })
  } finally {
    setReadFileCache(conversation.getReadFileState())
    const settled = conversation.getMessages()
    const seedIntact = seedLength === 0 || (settled.length >= seedLength && settled[seedLength - 1] === mutableMessages[seedLength - 1])
    if (seedIntact) {
      if (settled.length > seedLength) mutableMessages.push(...settled.slice(seedLength))
    } else {
      mutableMessages.length = 0
      mutableMessages.push(...settled)
    }
  }
}
