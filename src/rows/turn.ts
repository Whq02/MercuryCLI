import { randomUUID } from 'node:crypto'
import { getSessionId, isSessionPersistenceDisabled } from '../bootstrap/state.js'
import type { Command } from '../commands.js'
import { queryEvents } from '../query.js'
import type { Terminal } from '../query/transitions.js'
import type { RunEvent } from '../run-core/events.js'
import { legacyYieldsOf } from '../run-core/project-legacy.js'
import type { QueryParams } from '../run-core/turn-machine.js'
import { EMPTY_USAGE, type NonNullableUsage } from '../services/api/emptyUsage.js'
import { accumulateUsage, updateUsage } from '../services/providers/anthropic/cacheAndUsage.js'
import type { Tools, ToolUseContext } from '../Tool.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/constants.js'
import type { AssistantMessage, CompactMetadata, Message, MessageOrigin } from '../types/message.js'
import type { ApiStreamEvent, ContentBlockParam } from '../types/wire.js'
import type { BatchedPrompt, QueuedCommand } from '../types/textInputTypes.js'
import { createAttachmentMessage } from '../utils/attachments/orchestrator.js'
import { getQueuedCommandAttachments } from '../utils/attachments/queuedCommands.js'
import { createGetAppStateWithAllowedTools } from '../utils/forkedAgent.js'
import { isBareMode, isEnvTruthy } from '../utils/envUtils.js'
import type { FileStateCache } from '../utils/fileStateCache.js'
import { cloneFileStateCache } from '../utils/fileStateCache.js'
import { reconstructContentReplacementState, type ContentReplacementState } from '../utils/toolResultStorage.js'
import { fileHistoryMakeSnapshot } from '../utils/fileHistory.js'
import { headlessProfilerCheckpoint } from '../utils/headlessProfiler.js'
import { forgetWardFirings, wardFiringsOf } from '../guards/wardsGuard.js'
import { getInMemoryErrors, logError } from '../utils/log.js'
import { isClaudeAISubscriber } from '../utils/auth.js'
import { turnCutOf } from '../utils/messages/turnCut.js'
import type { HookAttachment } from '../utils/attachments/types.js'
import { getEngineModel } from '../utils/model/model.js'
import { resolveModelPricing } from '../utils/modelCost.js'
import { getTokenUsage, messageContextFill } from '../utils/tokens.js'
import { getModelUsage, getTotalCostUSD } from '../bootstrap/state.js'
import { ledgerMark, ledgerSpentSince, usageSince } from '../utils/ledgerMark.js'
import { noteRunPhase } from '../utils/runPhases.js'
import { processUserInput } from '../utils/processUserInput/processUserInput.js'
import { getSlashCommandToolSkills } from '../commands.js'
import { ensureExtensionsLoaded } from '../extensions/boot.js'
import { flushSessionStorage, recordTranscript } from '../utils/sessionStorage.js'
import { recordTurnStart, settleTranscriptMessage } from '../utils/sessionStorage/writer.js'
import { setCwd } from '../utils/Shell.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import { shouldEnableThinkingByDefault } from '../utils/thinking.js'
import { getCwd } from '../utils/cwd.js'
import { describeArtifactIdentity } from '../utils/artifactIdentity.js'
import {
  compactionEndedRow,
  modelUsageRows,
  noticeRow,
  outcomeRow,
  partialRowsOf,
  retractedRow,
  toolResultRowsOf,
  turnStartedRow,
  type OutcomeFacts,
  type RowDraft,
  type RowScope,
  type SessionFacts,
} from './project.js'
import { budgetCannotPaySentence, statusOfTerminal, HOOK_NOTICE_CODES, OUTCOME_SENTENCES, type Denial, type OutcomeStatus, type Usage } from './vocabulary.js'
import { recoveryKindOf, type RecoveryKind } from './vocabulary.js'
import { StepLedger } from './turn/steps.js'
import { messageRowsOf } from './turn/messageRows.js'
import { canUseToolKeepingDenials } from './turn/asks.js'
import { systemPromptComposer } from './turn/prompt.js'
import { armTurnGuards } from './turn/guards.js'
import { contextBuilder } from './turn/context.js'
import { commandOutputRows } from './turn/command.js'
import { latestAnswerOf } from './turn/answer.js'
import { openCallsCutter } from './turn/cut.js'
import { turnEnder } from './turn/end.js'
import { MaxTimeCut, settledTurnRows } from './turn/settle.js'
import { costUnknownIn } from './turn/close.js'
import { systemMessageRows } from './turn/system.js'

export { closeRowOf } from './turn/close.js'

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
  maxTime?: { limitMs: number; at: number }
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
  operatorPrompt?: boolean
  mode?: 'prompt' | 'bash'
  batchUuids?: string[]
  batchTail?: BatchedPrompt[]
  initialNotices?: QueuedCommand[]
  origin?: MessageOrigin
  skipSlashCommands?: boolean
  syntaxInput?: string
  turn?: number
}


function inputFloorUsd(messages: readonly Message[], model: string): number | null {
  const pricing = resolveModelPricing(model)
  if (pricing.basis !== 'recorded' && pricing.basis !== 'floor') return null
  if (messageContextFill(messages, model).source !== 'usage') return null
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getTokenUsage(messages[index])
    if (!usage) continue
    const carried = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    return (carried * Math.min(pricing.costs.promptCacheReadTokens, pricing.costs.inputTokens)) / 1e6
  }
  return null
}

export async function sessionFactsOf(config: Pick<ConversationConfig, 'cwd' | 'tools' | 'mcpClients' | 'commands' | 'agents'>, model: string, mode: string, resumeOf?: string, toolsWithheld?: SessionFacts['toolsWithheld']): Promise<SessionFacts> {
  headlessProfilerCheckpoint('before_skills_extensions')
  const [skills, loaded] = await Promise.all([getSlashCommandToolSkills(config.cwd), ensureExtensionsLoaded({ cwd: config.cwd })])
  headlessProfilerCheckpoint('after_skills_extensions')
  const invocable = (entry: { userInvocable?: boolean }): boolean => entry.userInvocable !== false
  const build = describeArtifactIdentity(MACRO.VERSION).buildTree
  return {
    version: MACRO.VERSION,
    ...(build !== null ? { build } : {}),
    ...(resumeOf !== undefined ? { resumeOf } : {}),
    cwd: getCwd(),
    model,
    mode,
    tools: config.tools.map(tool => tool.name),
    ...(toolsWithheld !== undefined && toolsWithheld.length > 0 ? { toolsWithheld } : {}),
    mcpServers: config.mcpClients.map(client => ({ name: client.name, status: client.type })),
    commands: config.commands.filter(invocable).map(command => command.name),
    agents: (config.agents ?? []).map(agent => agent.agentType),
    skills: skills.filter(invocable).map(skill => skill.name),
    extensions: loaded.set.active.map(ext => ({ name: ext.manifest.name, path: ext.root, id: ext.entry.id })),
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
  private readonly unansweredAsks = new Set<string>()
  private accumulatedUsage: NonNullableUsage = { ...EMPTY_USAGE }
  private readonly streamFoldedIds = new Set<string>()
  private readonly settledUsageById = new Map<string, NonNullableUsage>()
  private turnOrdinal = 0
  private recordCursor = 0
  private recordChain: Promise<string | null> = Promise.resolve(null)
  private turnToOpen: string | undefined
  private structuredOutput: unknown

  constructor(config: ConversationConfig) {
    this.config = config
    this.mutableMessages = [...(config.initialMessages ?? [])]
    this.readFileState = config.readFileState
    this.contentReplacementState = config.contentReplacementState ?? reconstructContentReplacementState(this.mutableMessages, [])
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
    const opening = this.turnToOpen
    this.turnToOpen = undefined
    this.recordChain = this.recordChain.then(hint =>
      (opening === undefined ? Promise.resolve() : recordTurnStart(opening)).then(() => recordTranscript(pending, (hint ?? undefined) as Parameters<typeof recordTranscript>[1], turnMessages)).catch((error: unknown) => {
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
    const modelUsageAtStart = Object.fromEntries(Object.entries(getModelUsage()).map(([model, row]) => [model, { ...row }]))
    const ledgerAtStart = { ...ledgerMark(), modelUsage: modelUsageAtStart }
    const eagerFlush = isEnvTruthy(flagEnv('MERCURY_EAGER_FLUSH'))
    const errorWatermark = getInMemoryErrors().at(-1)
    this.turnOrdinal += 1
    const turnOrdinal = options?.turn ?? this.turnOrdinal
    const turnId = randomUUID()
    this.turnToOpen = turnId
    const promptUuid = options?.uuid ?? randomUUID()
    const scope: RowScope = { session_id: getSessionId(), turn: turnOrdinal }
    const notices: Array<{ level: 'warning' | 'error'; text: string }> = []
    const recoveries: Array<{ kind: RecoveryKind }> = []
    const hookNoticeRows = (hookRow: HookAttachment): RowDraft[] => {
      if (hookRow.outcome !== 'failed' && hookRow.outcome !== 'block' && hookRow.outcome !== 'stop' && hookRow.outcome !== 'notice') return []
      const text = hookRow.outcome === 'failed' || hookRow.outcome === 'notice' ? hookRow.words : `hook ${hookRow.name} ${hookRow.outcome === 'block' ? 'blocked' : 'stopped'} ${hookRow.event}: ${hookRow.words}`
      notices.push({ level: 'warning', text })
      return [noticeRow(scope, 'warning', text, HOOK_NOTICE_CODES[hookRow.outcome])]
    }
    const steps = new StepLedger(scope)
    const toolOutcomes = new Map<string, 'ok' | 'error' | 'aborted'>()
    const callScopes = new Map<string, RowScope>()
    const denialsBefore = this.denials.length
    forgetWardFirings(scope.session_id)

    const wrappedCanUseTool = canUseToolKeepingDenials(config, this.denials, this.unansweredAsks)

    const appStateSnapshot = config.getAppState()
    const resolvedModel = this.userSpecifiedModel ?? getEngineModel()
    const thinkingConfig: ThinkingConfig =
      config.thinkingConfig ?? (shouldEnableThinkingByDefault() ? ({ type: 'adaptive' } as ThinkingConfig) : ({ type: 'disabled' } as ThinkingConfig))

    const compose = systemPromptComposer(config, resolvedModel, appStateSnapshot, prompt)
    headlessProfilerCheckpoint('before_getSystemPrompt')
    const promptParts = await compose()
    headlessProfilerCheckpoint('after_getSystemPrompt')
    const systemPrompt = promptParts.systemPrompt

    const sessionId = getSessionId()
    armTurnGuards(config, sessionId)

    const buildContext = contextBuilder({ config, thinkingConfig, turnId, abortController: this.abortController, readFileState: this.readFileState, contentReplacementState: this.contentReplacementState, discoveredSkillNames: this.discoveredSkillNames, loadedNestedMemoryPaths: this.loadedNestedMemoryPaths })
    if (options?.initialNotices?.length) {
      const attachments = await getQueuedCommandAttachments(options.initialNotices, { messages: this.mutableMessages, model: resolvedModel })
      this.mutableMessages.push(...attachments.map(createAttachmentMessage))
      if (!persistenceDisabled) await this.recordDelta(this.mutableMessages)
    }
    let toolUseContext = buildContext(this.mutableMessages, resolvedModel)

    const messageIds = [promptUuid, ...(options?.batchUuids ?? []).filter(uuid => uuid !== promptUuid)]
    yield turnStartedRow(scope, { turnId, messageIds, model: resolvedModel })

    const rowsOfMessage = messageRowsOf({ scope, steps, toolOutcomes, callScopes })

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
      ...(options?.operatorPrompt !== undefined ? { operatorPrompt: options.operatorPrompt } : {}),
      ...(options?.origin !== undefined ? { origin: options.origin } : {}),
      ...(options?.skipSlashCommands === true ? { skipSlashCommands: true } : {}),
      querySource: 'sdk',
      canUseTool: wrappedCanUseTool,
    })

    for (const message of inputResult.messages) {
      if (!priorUuids.has(message.uuid) && message.type === 'attachment' && message.attachment.type === 'hook') {
        yield* hookNoticeRows(message.attachment)
      }
    }
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

    const effectiveModel = inputResult.model ?? resolvedModel
    steps.lastModel = effectiveModel
    toolUseContext = buildContext(turnMessages, effectiveModel)
    toolUseContext.getAppState = createGetAppStateWithAllowedTools(toolUseContext.getAppState, inputResult.allowedTools ?? [])

    let capturedStopReason: string | null = null

    const outcomeFactsOf = (status: OutcomeStatus, extra: Partial<OutcomeFacts> = {}): OutcomeFacts => {
      for (const [messageId, usage] of this.settledUsageById) {
        if (this.streamFoldedIds.has(messageId)) continue
        this.streamFoldedIds.add(messageId)
        if (usage.input_tokens === 0 && usage.output_tokens === 0) continue
        this.accumulatedUsage = accumulateUsage(this.accumulatedUsage, usage)
      }
      noteRunPhase('settlement')
      const spent = ledgerSpentSince(ledgerAtStart)
      const unpricedModels = new Set(Object.keys(spent.unpricedTurns))
      const apiMs = spent.apiDuration
      const billed = usageSince(getModelUsage(), modelUsageAtStart)
      const subscriber = isClaudeAISubscriber()
      const hasUnknownCost = costUnknownIn(spent.unpricedTurns, subscriber)
      const pricedModels = Object.keys(billed).filter(model => !hasUnknownCost(model))
      const costUsd = subscriber ? pricedModels.reduce((sum, model) => sum + Math.max(0, billed[model]?.costUSD ?? 0), 0) : spent.costUSD
      const costKnown = subscriber ? pricedModels.length > 0 : unpricedModels.size === 0 || costUsd > 0
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
        ...(costKnown ? { costUsd } : {}),
        ...(recoveries.length > 0 ? { recoveries: [...recoveries] } : {}),
        usage,
        models: modelUsageRows(billed, hasUnknownCost),
        denials: this.denials.slice(denialsBefore),
        ...(notices.length > 0 ? { notices: [...notices] } : {}),
        wards: wardFiringsOf(scope.session_id),
        ...extra,
      }
    }
    const openCalls = new Map<string, string>()
    let recoveredUnansweredAsk = false
    const containsUnansweredAsk = (callId: string): boolean => this.denials.slice(denialsBefore).some(denial => {
      if (!this.unansweredAsks.has(denial.call_id)) return false
      const seen = new Set<string>()
      let parent = callScopes.get(denial.call_id)?.parent_call_id
      while (parent !== undefined && !seen.has(parent)) {
        if (parent === callId) return true
        seen.add(parent)
        parent = callScopes.get(parent)?.parent_call_id
      }
      return false
    })
    const cutCalls: string[] = []
    const signal = this.abortController.signal
    const trackCalls = (rows: RowDraft[]): RowDraft[] => {
      for (const row of rows) {
        const call = row as RowDraft & { call_id?: string; tool?: string; status?: string }
        if (call.type === 'tool_call' && call.call_id !== undefined) openCalls.set(call.call_id, call.tool ?? '')
        if (call.type === 'tool_result' && call.call_id !== undefined) {
          const tool = openCalls.get(call.call_id)
          if (this.unansweredAsks.has(call.call_id)) recoveredUnansweredAsk = false
          else if (call.status === 'ok' && tool !== undefined && tool !== 'ToolSearch' && !containsUnansweredAsk(call.call_id)) recoveredUnansweredAsk = true
          if ((call.status === 'aborted' || signal.aborted) && tool !== undefined) cutCalls.push(tool)
          openCalls.delete(call.call_id)
        }
      }
      return rows
    }
    const closeTurn = (status: OutcomeStatus, extra: Partial<OutcomeFacts> = {}): RowDraft => outcomeRow({ ...scope, turn: turnOrdinal }, outcomeFactsOf(status, extra))
    let timeLimitTimer: ReturnType<typeof setTimeout> | null = null
    const turnEnding = turnEnder({ scope, turnId, sessionId, abortController: this.abortController, toolUseContext, inputResult, mutableMessages: this.mutableMessages, turnMessages, seedMessages, persistenceDisabled, recordDelta: turnMessages => this.recordDelta(turnMessages), cutCalls, openCalls })
    const endTurn = async function* (this: Conversation, status: OutcomeStatus, extra: Partial<OutcomeFacts> = {}): AsyncGenerator<RowDraft> {
      if (timeLimitTimer !== null) {
        clearTimeout(timeLimitTimer)
        timeLimitTimer = null
      }
      const row = closeTurn(status, extra) as RowDraft & { stop?: string; error?: { message: string; class: string }; steps: number; wall_ms: number; cost_usd?: number; usage: Usage; answer?: string }
      yield* turnEnding(status, row)
      yield row
    }.bind(this)

    headlessProfilerCheckpoint('turn_row_yielded')
    noteRunPhase('assembly')

    if (!inputResult.shouldQuery) {
      const commandAnswer = yield* commandOutputRows(inputResult, priorUuids, scope, prompt, options)
      if (!persistenceDisabled) {
        await this.recordDelta(turnMessages)
        if (eagerFlush) await flushSessionStorage()
      }
      if (options?.mode === 'bash' && this.abortController.signal.aborted) {
        const cut = turnCutOf(this.abortController.signal.reason)
        const ended = statusOfTerminal({ reason: 'aborted_tools' }, cut.kind)
        yield* endTurn(ended.status, { error: { message: ended.status === 'interrupted' ? OUTCOME_SENTENCES.interrupted({}) : cut.kind === 'idle-timeout' ? 'The turn was aborted after a no-progress timeout' : `The turn was cut: ${cut.detail ?? 'the run was aborted'}`, class: ended.errorClass ?? 'interrupt' } })
        return
      }
      if (inputResult.commandError !== undefined) {
        yield* endTurn('failed', { error: { message: inputResult.commandError, class: 'command' } })
        return
      }
      const refused = inputResult.commandRefused === true || inputResult.hookBlocked === true
      yield* endTurn(refused ? 'refused' : 'completed', {
        ...(refused
          ? { error: { message: inputResult.resultText ?? 'The request was refused', class: inputResult.hookBlocked === true ? 'hook' : 'command' } }
          : { answer: inputResult.resultText ?? commandAnswer }),
      })
      return
    }

    if (!persistenceDisabled) {
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
    const latestAnswer = latestAnswerOf(turnMessages)
    const maxTimeReached = (): boolean => config.maxTime !== undefined && Date.now() >= config.maxTime.at
    const timeLimitFacts = (): Partial<OutcomeFacts> => ({ error: { message: OUTCOME_SENTENCES.time_limit({ maxTimeMs: config.maxTime?.limitMs }), class: 'time_limit' } })
    const cutOpenCalls = openCallsCutter({ turnMessages, messages, openCalls, toolOutcomes, persistenceDisabled, recordDelta, trackCalls, rowsOfMessage })
    if (maxTimeReached()) {
      yield* endTurn('time_limit', timeLimitFacts())
      return
    }
    if (config.maxTime !== undefined) {
      const sentence = OUTCOME_SENTENCES.time_limit({ maxTimeMs: config.maxTime.limitMs })
      timeLimitTimer = setTimeout(() => this.abortController.abort(new MaxTimeCut(sentence)), Math.max(0, config.maxTime.at - Date.now()))
      timeLimitTimer.unref?.()
    }

    const queryParams: QueryParams = {
      messages: turnMessages,
      systemPrompt,
      userContext: promptParts.userContext,
      systemContext: promptParts.systemContext,
      recompose: compose,
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
      if (event.kind === 'turn_settled') {
        const recovery = recoveryKindOf(event.transition)
        if (recovery !== undefined) recoveries.push({ kind: recovery })
      }
      if (event.kind === 'assistant_retracted') {
        const withdrawn = (event.message as AssistantMessage).message.id
        if (config.partialRows && typeof withdrawn === 'string') yield retractedRow(scope, withdrawn)
        for (const block of (event.message as AssistantMessage).message.content) {
          if (block.type !== 'tool_use' || !openCalls.delete(block.id) || config.partialRows) continue
          yield* toolResultRowsOf(scope, [{ type: 'tool_result', tool_use_id: block.id, content: '', is_error: true }], () => 'aborted')
        }
        if (!persistenceDisabled) await settleTranscriptMessage({ ...(event.message as AssistantMessage), retracted: true })
        const withdrawnUuid = (event.message as AssistantMessage).uuid
        const held = this.mutableMessages.findIndex(row => row.uuid === withdrawnUuid)
        if (held !== -1) this.mutableMessages.splice(held, 1)
        const inTurn = turnMessages.findIndex(row => row.uuid === withdrawnUuid)
        if (inTurn !== -1) {
          turnMessages.splice(inTurn, 1)
          if (inTurn < this.recordCursor) this.recordCursor--
        }
        continue
      }

      for (const projected of legacyYieldsOf(event)) {
        const kind = (projected as { type?: string }).type
        const message = projected as Message & { subtype?: string }
        let shouldRecord = false
        let isBoundary = false

        switch (kind) {
          case 'stream_request_start': {
            if (!persistenceDisabled && !isBareMode()) {
              await recordDelta()
              await flushSessionStorage().catch(() => {})
            }
            const floor = config.maxBudgetUsd === undefined ? null : inputFloorUsd(this.mutableMessages, currentStreamModel)
            if (config.maxBudgetUsd !== undefined && floor !== null && getTotalCostUSD() + floor > config.maxBudgetUsd) {
              if (eagerFlush) await flushSessionStorage()
              const open = steps.flush()
              if (open !== null) yield open
              const sentence = budgetCannotPaySentence({ maxBudgetUsd: config.maxBudgetUsd, spentUsd: getTotalCostUSD(), inputFloorUsd: floor })
              yield* cutOpenCalls(sentence)
              yield* endTurn('budget_limit', { error: { message: sentence, class: 'budget_limit' } })
              return
            }
            break
          }
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
            for (const row of trackCalls(rowsOfMessage(message, undefined))) yield row
            break
          }
          case 'attachment': {
            this.mutableMessages.push(message)
            turnMessages.push(message)
            const attachment = (projected as { attachment?: { type?: string } }).attachment
            const attachmentType = attachment?.type
            if (attachmentType === 'dead_thinking' || attachmentType === 'dropped_thinking' || attachmentType === 'bound_prefix' || attachmentType === 'images_left_out') {
              await recordDelta()
              if (!persistenceDisabled) await flushSessionStorage()
            } else {
              void recordDelta()
            }
            if (attachmentType === 'hook') {
              yield* hookNoticeRows(attachment as HookAttachment)
            } else if (attachmentType === 'structured_output') {
              this.structuredOutput = (attachment as { data?: unknown }).data
            } else if (attachmentType === 'max_turns_reached') {
              if (eagerFlush) await flushSessionStorage()
              const open = steps.flush()
              if (open !== null) yield open
              const closingAnswer = latestAnswer()
              yield* endTurn('turn_limit', { error: { message: OUTCOME_SENTENCES.turn_limit({ maxTurns: config.maxTurns }), class: 'turn_limit' }, ...(closingAnswer !== '' ? { answer: closingAnswer } : {}) })
              return
            } else if (attachmentType === 'loop_stopped') {
              if (eagerFlush) await flushSessionStorage()
              const stopped = attachment as { message?: string; cycle?: string[] }
              const open = steps.flush()
              if (open !== null) yield open
              yield* endTurn('loop_stopped', {
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
            if (yield* systemMessageRows({ scope, ledgerAtStart, turnStartedAt, mutableMessages: this.mutableMessages, turnMessages, notices, recordDelta }, message)) break
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
            if (isBoundary && !persistenceDisabled) await recordTurnStart(turnId).catch((error: unknown) => logError(error))
            if (!persistenceDisabled) await flushSessionStorage().catch(() => {})
          }
        }
        if (kind === 'assistant') {
          for (const row of trackCalls(rowsOfMessage(message, undefined))) yield row
        } else if (kind === 'user') {
          for (const row of trackCalls(rowsOfMessage(message, undefined))) yield row
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
          yield* cutOpenCalls(OUTCOME_SENTENCES.budget_limit({ maxBudgetUsd: config.maxBudgetUsd }))
          yield* endTurn('budget_limit', { error: { message: OUTCOME_SENTENCES.budget_limit({ maxBudgetUsd: config.maxBudgetUsd }), class: 'budget_limit' } })
          return
        }
        const moreStepsAhead = kind === 'user' || isBoundary || (kind === 'assistant' && (message as AssistantMessage).message.content.some(block => block.type === 'tool_use'))
        if (moreStepsAhead && maxTimeReached()) {
          if (eagerFlush) await flushSessionStorage()
          const open = steps.flush()
          if (open !== null) yield open
          yield* cutOpenCalls(OUTCOME_SENTENCES.time_limit({ maxTimeMs: config.maxTime?.limitMs }))
          yield* endTurn('time_limit', timeLimitFacts())
          return
        }
        if (kind === 'user' && config.jsonSchema) {
          const retries = this.countSyntheticOutputCalls() - syntheticCallsBeforeTurn
          const maxRetries = Number.parseInt(flagEnv('MERCURY_STRUCTURED_OUTPUT_RETRIES') ?? String(DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES), 10)
          if (retries >= maxRetries) {
            if (eagerFlush) await flushSessionStorage()
            const open = steps.flush()
            if (open !== null) yield open
            yield* endTurn('schema_unmet', { error: { message: OUTCOME_SENTENCES.schema_unmet({}), class: 'schema_unmet', detail: [`Structured output failed after ${retries} attempts`] } })
            return
          }
        }
      }
    }

    noteRunPhase('terminal')
    if (eagerFlush) await flushSessionStorage()
    const open = steps.flush()
    if (open !== null) yield open

    const answer = latestAnswer()

    yield* settledTurnRows({ config, terminal, answer, abortController: this.abortController, turnMessages, seedMessages, denials: this.denials, denialsBefore, unansweredAsks: this.unansweredAsks, recoveredUnansweredAsk, notices, apiErrorMessage, structuredOutput: this.structuredOutput, errorWatermark, timeLimitFacts, endTurn })
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
  operatorPrompt?: boolean
  turn?: number
  mutableMessages?: Message[]
  onTurnMessages?: (read: (() => readonly Message[]) | null) => void
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
}

export async function* ask(options: AskOptions): AsyncGenerator<RowDraft, void, unknown> {
  const { prompt, promptUuid, isMeta, operatorPrompt, origin, skipSlashCommands, syntaxInput, batchUuids, batchTail, initialNotices, promptMode, turn, mutableMessages = [], onTurnMessages, getReadFileCache, setReadFileCache, ...config } = options
  const conversation = new Conversation({
    ...config,
    initialMessages: mutableMessages,
    readFileState: cloneFileStateCache(getReadFileCache()),
  })
  const seedLength = mutableMessages.length
  onTurnMessages?.(() => conversation.getMessages())
  try {
    yield* conversation.turn(prompt, {
      syntaxInput,
      uuid: promptUuid,
      isMeta,
      ...(operatorPrompt !== undefined ? { operatorPrompt } : {}),
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
    onTurnMessages?.(null)
  }
}
