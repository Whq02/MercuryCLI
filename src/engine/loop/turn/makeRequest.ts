import { LOCAL_COMMAND_STDOUT_TAG } from '../../message-shapes/messageTags.js'
import { resetSessionEnvNoticeOnCompaction } from '../../../tools/kit/sessionEnvNotice.js'
import {
  AUTOCOMPACT_THRASH_MESSAGE,
  calculateTokenWarningState,
  getBlockingLimit,
  isAutoCompactEnabled,
  rapidRefillPauseText,
  type AutoCompactTrackingState,
} from '../../compaction/autoFold.js'
import {
  decideOverflowRecovery,
  foldAvailability,
  foldRemedyIsHeadless,
  overflowGapFor,
  overflowLadderArmed,
  overflowRecoveryNotice,
  overflowRefusalText,
  splitCarriedOperatorTail,
  type OverflowEpisode,
} from '../../compaction/overflowRecovery.js'
import { estimateContextTokens, projectTimeBasedMicrocompact } from '../../compaction/pruneToolResults.js'
import { estimateOverflowSignal } from '../../requests/overflowSignal.js'
import { API_ERROR_MESSAGE_PREFIX, PROMPT_TOO_LONG_ERROR_MESSAGE } from '../../requests/apiErrorRows.js'
import { createAssistantAPIErrorMessage, createCommandInputMessage, createSystemMessage, createUserMessage } from '../../messages/messages.js'
import { createDeadThinkingAttachment, deadThinkingMarks } from '../../../models/roads/anthropic/thinkingBinding.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import { fireHooks } from '../../../integrations/event-hooks/fire.js'
import { hookRowsOfResult } from '../../../integrations/event-hooks/rows.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'
import { advanceToolCallChain, type ToolUseContext } from '../../../tools/kit/tool.js'
import { asSystemPrompt, type SystemPrompt } from '../../system-prompt/systemPromptType.js'
import type { AttachmentMessage, Message } from '../../message-shapes/message.js'
import { appendSystemContext, firstTurnUserContext } from '../../messages/apiSystemAndToolSchema.js'
import { latestUserContextBody } from '../../attachment-shapes/userContext.js'
import { createAttachmentMessage } from '../../attachments/attachments.js'
import { headlessProfilerCheckpoint } from '../../../platform/logs/headlessProfiler.js'
import { tokenCountWithEstimation } from '../../context-window/contextTokenCount.js'
import { EarlyStarts } from '../../tool-dispatch/earlyStarts.js'
import { emitCompactionTrace } from '../../../platform/observability/invocationTrace.js'
import { flushSessionStorage, recordContentReplacement } from '../../../sessions/transcripts/sessionStorage.js'
import { buildRequestContextPlan, type RequestContextPlan } from '../../run/requestContextPlan.js'
import { calibrationKeyFor } from '../../run/contextCalibration.js'
import { randomUUID } from 'node:crypto'
import { requestGaugeFixed } from '../../run/requestGauge.js'
import { buildPostCompactMessages, ERROR_MESSAGE_USER_ABORT } from '../../compaction/foldConversation.js'
import { toolToAPISchema } from '../../messages/apiSystemAndToolSchema.js'
import { declaredRouteOf } from '../../../models/roads/callModelRouter.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../../run-owner/resolveOwner.js'
import { planToolPayloadUnseeded, toolsOnTheWire } from '../../../models/roads/toolEconomy.js'
import { localPromptFitRefusal, localPromptFits } from '../../../models/roads/local/localCallModel.js'
import { countToolDefinitionTokens, TOOL_TOKEN_COUNT_OVERHEAD } from '../../context-window/analyzeContext.js'
import { tellHowToolDefinitionsAreCounted } from '../../messages/toolSearch.js'
import type { QueryDeps } from '../../turn-entry/turnLoopDeps.js'
import type { Terminal } from '../../turn-entry/transitions.js'
import type { RunEvent } from '../events.js'
import type { IterationState, NextTurn, RequestDecision, RunCtx, SettledDecision, TurnState } from './turnState.js'

tellHowToolDefinitionsAreCounted(countToolDefinitionTokens, TOOL_TOKEN_COUNT_OVERHEAD)

type Autocompacted = Awaited<ReturnType<QueryDeps['autocompact']>>

type PlannedContext = {
  requestPlan: RequestContextPlan
  messagesForQuery: Message[]
  prunedTokensFreed: number
  thinkingRecords: AttachmentMessage[]
  fullSystemPrompt: SystemPrompt
}

type FoldedContext = {
  kind: 'go_on'
  messagesForQuery: Message[]
  tracking: AutoCompactTrackingState | undefined
  overflowEpisode: OverflowEpisode
  fullSystemPrompt: SystemPrompt
  compactionResult: Autocompacted['compactionResult']
  consecutiveFailures: Autocompacted['consecutiveFailures']
  measuredRawTokenCount: Autocompacted['measuredRawTokenCount']
  compactionRefusal: Autocompacted['refusal']
  foldSplit: ReturnType<typeof splitCarriedOperatorTail>
}

type FittingRequest = {
  kind: 'go_on'
  toolUseContext: ToolUseContext
  appState: ReturnType<ToolUseContext['getAppState']>
  currentModel: string
}

const PRUNE_PROJECTION = { pressure: true, supersededOnly: true } as const

export async function* planContext(run: RunCtx, state: TurnState, toolUseContext: ToolUseContext): AsyncGenerator<RunEvent, PlannedContext> {
  const { emit, querySource } = run
  const { messages, pendingOverflow } = state
  const { options } = toolUseContext
  const engine = options.engineModel
  const agents = options.agentDefinitions.activeAgents
  const getToolPermissionContext = async () => toolUseContext.getAppState().toolPermissionContext

  const system = appendSystemContext(run.systemPrompt, run.systemContext, engine)
  const userContext =
    latestUserContextBody(messages) === null ? await firstTurnUserContext(run.userContext, run.systemContext, engine, toolUseContext.agentId, messages) : null
  const payload = await planToolPayloadUnseeded({
    model: engine,
    tools: options.tools,
    messages,
    getToolPermissionContext,
    agents,
    hasPendingMcpServers: toolUseContext.getAppState().mcp.clients.some((client: { type: string }) => client.type === 'pending'),
    latchKey: String(rosterOwnerFromToolUseContext(toolUseContext)),
    source: 'gauge',
  })
  const tools = await Promise.all(
    toolsOnTheWire(payload).map(tool =>
      toolToAPISchema(tool, { getToolPermissionContext, tools: options.tools, agents, allowedAgentTypes: options.agentDefinitions.allowedAgentTypes, model: engine }).catch(
        passedOverAs({ name: tool.name }),
      ),
    ),
  )

  const persists = querySource === 'sdk' || querySource.startsWith('agent:') || querySource.startsWith('main_thread')
  const requestPlan = await buildRequestContextPlan(
    {
      messages,
      owner: ownerFromToolUseContext(toolUseContext),
      querySource,
      engineModel: engine,
      contentReplacementState: toolUseContext.contentReplacementState,
      readFileState: toolUseContext.readFileState,
      persistReplacements: persists
        ? async records => {
            await recordContentReplacement(records, toolUseContext.agentId)
            await flushSessionStorage()
          }
        : undefined,
      skipToolNames: new Set(options.tools.filter(tool => !Number.isFinite(tool.maxResultSizeChars)).map(tool => tool.name)),
      microcompact: run.deps.microcompact,
      preserveBodies: pendingOverflow?.rung !== 'prune',
      calibrationKey: engine ? calibrationKeyFor(declaredRouteOf(engine) ?? 'unrecognised', engine) : null,
      fixedRequest: requestGaugeFixed({ system, userContext, tools }),
      harnessContextPolicy: null,
      ...(pendingOverflow?.rung === 'prune' ? { pressurePrune: true as const } : {}),
    },
    'apply',
  )

  let messagesForQuery = requestPlan.messages
  const pruned = requestPlan.reductions.pressurePruned
  const prunedTokensFreed = requestPlan.gauge !== undefined ? 0 : Math.max(0, pruned?.tokensSaved ?? 0)
  if ((pruned?.cleared ?? 0) + requestPlan.reductions.timeBasedCleared > 0) {
    const digested = await fireHooks(
      'compaction.after',
      {
        method: 'digest',
        trigger: pendingOverflow?.rung === 'prune' ? 'overflow' : 'auto',
        tokens_before: estimateContextTokens(messages),
        tokens_after: estimateContextTokens(requestPlan.messages),
      },
      {
        scope: { sessionId: getSessionId(), ...(toolUseContext.agentId !== undefined ? { crewmateId: toolUseContext.agentId } : {}) },
        signal: toolUseContext.abortController.signal,
        toolUseContext,
      },
    )
    for (const row of hookRowsOfResult(digested)) yield emit({ kind: 'attachment', message: createAttachmentMessage(row) })
    if (digested.answer.contexts.length > 0) {
      messagesForQuery = [...requestPlan.messages, ...digested.answer.contexts.map(text => createUserMessage({ content: text, isMeta: true }))]
    }
  }

  const known = deadThinkingMarks(messages)
  const fresh = (requestPlan.reductions.deadThinkingMarks ?? []).filter(mark => known.get(mark.messageId)?.has(mark.blockIndex) !== true)
  const thinkingRecords: AttachmentMessage[] = []
  if (fresh.length > 0) {
    const record = createDeadThinkingAttachment(fresh)
    yield emit({ kind: 'attachment', message: record })
    thinkingRecords.push(record)
  }

  if (pendingOverflow?.rung === 'prune') {
    yield emit({
      kind: 'notice',
      message: createSystemMessage(overflowRecoveryNotice(pendingOverflow.signal, 'prune', pruned ?? { cleared: 0, tokensSaved: 0 }), 'warning'),
    })
  }
  if (messagesForQuery.length < requestPlan.afterBoundaryCount) {
    emitCompactionTrace('microcompact', { messagesBefore: requestPlan.afterBoundaryCount, messagesAfter: messagesForQuery.length })
  }
  const fullSystemPrompt = asSystemPrompt(appendSystemContext(run.systemPrompt, run.systemContext, engine))
  return { requestPlan, messagesForQuery, prunedTokensFreed, thinkingRecords, fullSystemPrompt }
}

export async function* foldContext(run: RunCtx, state: TurnState, toolUseContext: ToolUseContext, opened: Pick<FoldedContext, 'tracking' | 'overflowEpisode'>, planned: PlannedContext): AsyncGenerator<RunEvent, FoldedContext | SettledDecision> {
  const { emit, querySource } = run
  const { pendingOverflow } = state
  const forced = pendingOverflow?.rung === 'fold' ? pendingOverflow.signal : undefined
  const nonInteractive = foldRemedyIsHeadless(toolUseContext.options.isNonInteractiveSession)
  let view = planned.messagesForQuery
  const foldSplit = splitCarriedOperatorTail(view)

  const asked: Partial<Autocompacted> =
    pendingOverflow?.rung === 'prune'
      ? {}
      : await run.deps.autocompact(
          foldSplit.head,
          toolUseContext,
          {
            systemPrompt: run.systemPrompt,
            userContext: run.userContext,
            systemContext: run.systemContext,
            toolUseContext,
            forkContextMessages: foldSplit.head,
            postFoldCarry: foldSplit.carry,
          },
          querySource,
          opened.tracking,
          planned.prunedTokensFreed,
          forced,
        )
  const { compactionResult, consecutiveFailures, consecutiveRapidRefills, rapidRefillBreakerTripped, measuredRawTokenCount, refusal, paused, declined } = asked

  if (rapidRefillBreakerTripped) {
    yield emit({ kind: 'notice', message: createSystemMessage(`${AUTOCOMPACT_THRASH_MESSAGE} ${rapidRefillPauseText({ nonInteractive })}`, 'warning') })
  }
  const pauseHolds = opened.tracking?.rapidRefillPaused === true || rapidRefillBreakerTripped === true

  if (forced !== undefined && compactionResult === undefined) {
    const mayPrune = !toolUseContext.abortController.signal.aborted && (forced.source === 'provider' || (refusal !== undefined && refusal !== ERROR_MESSAGE_USER_ABORT))
    if (mayPrune) {
      const decision = decideOverflowRecovery({
        episode: opened.overflowEpisode,
        gapTokens: overflowGapFor(forced),
        pruneSavingTokens: projectTimeBasedMicrocompact(view, querySource, PRUNE_PROJECTION)?.tokensSaved ?? 0,
        pruneAllowed: true,
        fold: { available: false, why: 'fold-failed' },
      })
      if (decision.kind === 'recover' && decision.rung === 'prune') {
        const next: NextTurn = {
          ...state,
          messages: view,
          toolUseContext,
          autoCompactTracking: opened.tracking,
          overflowEpisode: { pruned: true, folded: true },
          pendingOverflow: { signal: forced, rung: 'prune' },
          transition: { reason: 'overflow_recovery', rung: 'prune', source: forced.source },
        }
        return { kind: 'hand_over', next }
      }
    }
    yield emit({
      kind: 'notice',
      message: createAssistantAPIErrorMessage({
        content: overflowRefusalText(forced, 'fold-failed', { nonInteractive, ...(refusal !== undefined ? { detail: refusal } : {}) }),
        error: 'invalid_request',
        ...(forced.detail !== undefined ? { errorDetails: forced.detail } : {}),
        overflow: forced,
      }),
    })
    const terminal: Terminal = forced.source === 'estimate' ? { reason: 'blocking_limit' } : { reason: 'prompt_too_long' }
    return { kind: 'end', terminal }
  }

  if (forced === undefined && (paused === true || declined === true) && refusal !== undefined) {
    yield emit({ kind: 'notice', message: createSystemMessage(refusal, 'warning') })
  }

  let tracking = opened.tracking
  let overflowEpisode = opened.overflowEpisode
  let fullSystemPrompt = planned.fullSystemPrompt
  if (compactionResult !== undefined) {
    const before = compactionResult.preCompactTokenCount
    const after = compactionResult.truePostCompactTokenCount ?? compactionResult.postCompactTokenCount
    emitCompactionTrace('auto-compact', { tokensFreed: typeof before === 'number' && typeof after === 'number' ? before - after : undefined })
    tracking = {
      compacted: true,
      turnId: run.deps.uuid(),
      turnCounter: 0,
      consecutiveFailures: 0,
      consecutiveRapidRefills,
      ...(pauseHolds ? { rapidRefillPaused: true } : {}),
    }
    const postFold = buildPostCompactMessages(compactionResult)
    const carried = foldSplit.carry.map(row => ({ ...row, uuid: randomUUID() }))
    yield emit({ kind: 'compaction_boundary', trigger: forced !== undefined ? 'overflow' : 'auto', messages: [...postFold, ...carried] })
    if (toolUseContext.agentId === undefined && compactionResult.boundaryMarker.compactMetadata.trigger === 'manual') {
      const { manualCompactDisplayText } = await import('../../compaction/manualReceipt.js')
      const display = manualCompactDisplayText(toolUseContext, compactionResult, foldSplit.head.length)
      yield emit({ kind: 'notice', message: createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${display}</${LOCAL_COMMAND_STDOUT_TAG}>`) })
    }
    resetSessionEnvNoticeOnCompaction()
    view = [...postFold, ...carried]
    overflowEpisode = { pruned: opened.overflowEpisode.pruned, folded: true }
    if (run.params.recompose !== undefined) {
      const composed = await run.params.recompose()
      run.systemPrompt = composed.systemPrompt
      run.userContext = composed.userContext
      run.systemContext = composed.systemContext
      const recomposed = asSystemPrompt(appendSystemContext(run.systemPrompt, run.systemContext, toolUseContext.options.engineModel))
      if (recomposed.join('\u001e') !== fullSystemPrompt.join('\u001e')) {
        logForDebugging('compaction: the system prompt was composed again after the fold, so the request that re-writes the context carries the new composition and the next turn reads it back')
      }
      fullSystemPrompt = recomposed
    }
  } else if (consecutiveFailures !== undefined || pauseHolds) {
    tracking = {
      ...(opened.tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
      ...(consecutiveFailures !== undefined ? { consecutiveFailures } : {}),
      ...(pauseHolds ? { rapidRefillPaused: true } : {}),
    }
  }

  return {
    kind: 'go_on',
    messagesForQuery: view,
    tracking,
    overflowEpisode,
    fullSystemPrompt,
    compactionResult,
    consecutiveFailures,
    measuredRawTokenCount,
    compactionRefusal: refusal,
    foldSplit,
  }
}

export async function* holdBlockingLimit(run: RunCtx, state: TurnState, toolUseContext: ToolUseContext, planned: PlannedContext, folded: FoldedContext): AsyncGenerator<RunEvent, FittingRequest | SettledDecision> {
  const { emit, querySource } = run
  const view = folded.messagesForQuery
  const fitted: ToolUseContext = { ...toolUseContext, messages: view }
  const engine = fitted.options.engineModel
  const appState = fitted.getAppState()
  const goOn = (): FittingRequest => ({ kind: 'go_on', toolUseContext: fitted, appState, currentModel: engine })
  const blocked: SettledDecision = { kind: 'end', terminal: { reason: 'blocking_limit' } }

  if (querySource === 'compact' || querySource === 'session_memory') return goOn()
  const landed = folded.compactionResult
  const trueCount: number | undefined = landed?.truePostCompactTokenCount
  if (landed !== undefined && trueCount === undefined) return goOn()
  const count = trueCount ?? Math.max(0, (folded.measuredRawTokenCount ?? tokenCountWithEstimation(view, engine)) - planned.prunedTokensFreed)
  if (calculateTokenWarningState(count, engine).level !== 'blocked') return goOn()

  const composed = { messages: view, systemPrompt: folded.fullSystemPrompt, tools: fitted.options.tools }
  if (localPromptFits(engine, composed)) {
    logForDebugging(`blocking preempt: the composed request fits ${engine}'s planned window — sent`)
    return goOn()
  }
  const localRefusal = localPromptFitRefusal(engine, composed)
  if (localRefusal !== undefined) {
    yield emit({ kind: 'notice', message: createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${localRefusal}`, error: 'invalid_request' }) })
    return blocked
  }
  if (!overflowLadderArmed(querySource)) {
    yield emit({ kind: 'notice', message: createAssistantAPIErrorMessage({ content: PROMPT_TOO_LONG_ERROR_MESSAGE, error: 'invalid_request' }) })
    return blocked
  }

  const limit = getBlockingLimit(engine)
  const signal = estimateOverflowSignal({ family: declaredRouteOf(engine) ?? 'unknown', actualTokens: count, limitTokens: limit })
  const refusal = folded.compactionRefusal
  const { hasHistory } = folded.foldSplit
  const headFoldFailed = (folded.consecutiveFailures ?? 0) > (state.autoCompactTracking?.consecutiveFailures ?? 0)
  const headFold = !hasHistory ? undefined : headFoldFailed ? ('failed' as const) : isAutoCompactEnabled() ? ('did-not-land' as const) : undefined
  const decision = decideOverflowRecovery({
    episode: folded.overflowEpisode,
    gapTokens: Math.max(1, count - limit),
    pruneSavingTokens: projectTimeBasedMicrocompact(view, querySource, PRUNE_PROJECTION)?.tokensSaved ?? 0,
    pruneAllowed: refusal !== undefined && refusal !== ERROR_MESSAGE_USER_ABORT,
    fold: foldAvailability({
      tracking: folded.tracking,
      ...(headFold !== undefined ? { headFold } : {}),
      ...(headFoldFailed && refusal !== undefined ? { headFoldDetail: refusal } : {}),
      hasHistory,
    }),
  })
  if (decision.kind === 'recover') {
    const { rung } = decision
    if (rung === 'fold') yield emit({ kind: 'notice', message: createSystemMessage(overflowRecoveryNotice(signal, rung), 'warning') })
    const next: NextTurn = {
      messages: view,
      toolUseContext: fitted,
      autoCompactTracking: folded.tracking,
      maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount,
      lastOutputLimitReply: state.lastOutputLimitReply,
      maxOutputTokensOverride: state.maxOutputTokensOverride,
      streamFaultRecoveryCount: state.streamFaultRecoveryCount,
      toolCallRefusalRecoveryCount: state.toolCallRefusalRecoveryCount,
      stopHookActive: state.stopHookActive,
      turnCount: state.turnCount,
      overflowEpisode: { pruned: folded.overflowEpisode.pruned || rung === 'prune', folded: folded.overflowEpisode.folded || rung === 'fold' },
      pendingOverflow: { signal, rung },
      transition: { reason: 'overflow_recovery', rung, source: 'estimate' },
    }
    return { kind: 'hand_over', next }
  }
  yield emit({
    kind: 'notice',
    message: createAssistantAPIErrorMessage({
      content: overflowRefusalText(signal, decision.why, {
        nonInteractive: foldRemedyIsHeadless(fitted.options.isNonInteractiveSession),
        ...(decision.detail !== undefined ? { detail: decision.detail } : {}),
      }),
      error: 'invalid_request',
      overflow: signal,
    }),
  })
  if (decision.why === 'breaker' && folded.tracking?.rapidRefillPaused === true) return { kind: 'end', terminal: { reason: 'rapid_refill_breaker' } }
  return blocked
}

export async function* makeRequest(run: RunCtx, state: TurnState, ordinal: number): AsyncGenerator<RunEvent, RequestDecision> {
  const turnId = `t${ordinal}`
  yield run.emit({ kind: 'turn_started', turnId, n: ordinal })
  if (state.toolUseContext.agentId === undefined) headlessProfilerCheckpoint('query_started')

  const callChain = advanceToolCallChain(state.toolUseContext, run.deps.uuid)
  const toolUseContext: ToolUseContext = { ...state.toolUseContext, callChain }
  const planned = yield* planContext(run, state, toolUseContext)
  const folded = yield* foldContext(run, state, toolUseContext, { tracking: state.autoCompactTracking, overflowEpisode: state.overflowEpisode }, planned)
  if (folded.kind !== 'go_on') return folded
  const fitting = yield* holdBlockingLimit(run, state, toolUseContext, planned, folded)
  if (fitting.kind !== 'go_on') return fitting

  const iter: IterationState = {
    state,
    turnId,
    requestPlan: planned.requestPlan,
    messagesForQuery: folded.messagesForQuery,
    toolUseContext: fitting.toolUseContext,
    callChain,
    tracking: folded.tracking,
    fullSystemPrompt: folded.fullSystemPrompt,
    appState: fitting.appState,
    currentModel: fitting.currentModel,
    maxOutputTokensOverride: state.maxOutputTokensOverride,
    assistantMessages: [],
    toolResults: [],
    thinkingRecords: planned.thinkingRecords,
    toolUseBlocks: [],
    needsFollowUp: false,
    closingTurn: run.budgetGuard.maxTurnsExceeded(state.turnCount, run.params.maxTurns),
    callOrdinal: 0,
    replyTo: run.awaitingReply,
    early: new EarlyStarts(fitting.toolUseContext, run.params.canUseTool),
    overflowEpisode: folded.overflowEpisode,
    allRefusedToolCalls: [],
    refusedToolCalls: [],
    answeredRefusalIds: new Set(),
    shouldPreventContinuation: false,
    loopStoppedCycle: null,
    loopStoppedRecord: null,
    updatedToolUseContext: fitting.toolUseContext,
  }
  return { kind: 'go_on', iter }
}
